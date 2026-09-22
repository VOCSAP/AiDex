#!/usr/bin/env python3
"""PreToolUse hook -- divert symbol lookups to AiDex, but only when AiDex can
actually answer them.

Lever C of the "AiDex over Grep" steering, complementing the always-loaded
AIDEX.md (lever A) and the model-invoked `aidex` skill (lever B). This hook is
the only deterministic layer: it fires on an actual search.

WHAT CHANGED IN LOT 5, AND WHY IT MATTERS
Until now this file GUESSED. It blocked any grep whose pattern looked like a
bare identifier as soon as a `.aidex/index.db` existed, without ever asking that
index whether it could answer -- and its refusal quoted a measurement typed in by
hand, in a file nothing connected to the index it described. Both halves were the
same mistake: a claim about an index, made without reading it.

Now the index answers for itself. The hook asks the coverage oracle
(`aidex can <pattern> --project <dir>`) and blocks ONLY on `covered: true`.
Everything else passes: every other verdict, and every failure to obtain one.

THE ASYMMETRY THAT DRIVES EVERY CHOICE BELOW
A wrong block costs a legitimate search refused, which teaches the model to work
around the tooling -- the exact behaviour this whole mechanism exists to end. A
wrong pass costs one redundant grep. So the hook fails OPEN, always: no oracle,
no verdict, no block.

THE PRE-FILTER IS A SECOND GUESSER, TOLERATED UNDER ONE CONDITION
Deciding what to send to the oracle is itself a judgement, made here, in Python,
about patterns. That is acceptable only because its error can cost nothing worse
than a missed teaching opportunity: it decides whether to ASK, never whether to
BLOCK. Which sets the direction for every future change to it -- widen what it
LETS THROUGH to the oracle, never what it decides on its own.

Wired in settings.json with matcher "Grep|Bash" so it covers BOTH:
  - the native Grep tool (tool_input.pattern), and
  - `grep` / `rg` / `egrep` / `fgrep` / `ripgrep` invoked through the Bash tool
    (parsed out of tool_input.command).
"""

import json
import os
import re
import shlex
import subprocess
import sys

# ---------------------------------------------------------------------------
# Reaching the oracle
# ---------------------------------------------------------------------------

# Where Claude records how to LAUNCH AiDex. That declaration already holds both
# things this hook needs -- the interpreter and the entry point -- so they are
# read from it rather than written down a second time here. Two copies of a path
# are one chance to disagree, and a hook carrying one machine's build directory
# is a hook that does nothing for everybody else.
#
# No absolute path belongs in this file, not even inside a comment as an
# example: `probe-hook-discovery.py` refuses the whole file if it finds one,
# and a rule with an "except when explaining" clause is a rule nobody enforces.
CLAUDE_CONFIGS = [
    os.path.join(os.path.expanduser("~"), ".claude.json"),
    os.path.join(os.environ.get("APPDATA") or "", "Claude", "claude_desktop_config.json"),
    os.path.join(os.path.expanduser("~"), "Library", "Application Support",
                 "Claude", "claude_desktop_config.json"),
    os.path.join(os.environ.get("XDG_CONFIG_HOME")
                 or os.path.join(os.path.expanduser("~"), ".config"),
                 "Claude", "claude_desktop_config.json"),
]


def discover_aidex():
    """Find (interpreter, entry point) from the MCP server declaration.

    Looks at the top-level `mcpServers` and at the per-project blocks, since
    Claude Code stores project-scoped servers under `projects.<path>.mcpServers`.
    Returns (None, None) when nothing is found -- which makes the hook inert
    rather than wrong.
    """
    for path in CLAUDE_CONFIGS:
        if not path or not os.path.isfile(path):
            continue
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except Exception:
            continue          # unreadable config is not a reason to block
        blocks = [data.get("mcpServers") or {}]
        for cfg in (data.get("projects") or {}).values():
            blocks.append((cfg or {}).get("mcpServers") or {})
        for servers in blocks:
            server = servers.get("aidex")
            if not isinstance(server, dict):
                continue
            command = server.get("command")
            args = server.get("args") or []
            if command and args:
                return command, args[0]
    return None, None


_discovered_node, _discovered_entry = discover_aidex()

# The interpreter matters. AiDex loads native addons (better-sqlite3,
# tree-sitter), so a `node` from a different major can abort on
# NODE_MODULE_VERSION before producing anything. The configured interpreter
# therefore comes first. An explicit override wins over discovery; `node` is the
# last resort, useful when only AIDEX_ENTRY is set. Candidates are tried in
# order, and if none yields a verdict the search passes.
NODE_CANDIDATES = [
    os.environ.get("AIDEX_NODE"),
    _discovered_node,
    "node",
]

AIDEX_ENTRY = os.environ.get("AIDEX_ENTRY") or _discovered_entry or ""

# The oracle budgets 150 ms of internal work and ~76 ms of process spawn. This
# ceiling is generous on purpose: hitting it means passing the search through,
# so it costs nothing but a redundant grep. Overridable so the fail-open path
# can be EXERCISED rather than reasoned about (set it to 0 and every spawn
# times out).
try:
    ORACLE_TIMEOUT_S = float(os.environ.get("AIDEX_TIMEOUT_S") or 5)
except ValueError:
    ORACLE_TIMEOUT_S = 5

# ---------------------------------------------------------------------------
# Pattern shape -- what is worth ASKING about
# ---------------------------------------------------------------------------

# Deliberately wider than the old bare-identifier test: since schema 1.3 an
# index can hold literals, so `sandbox:changed` and `config.json` are patterns
# the oracle may well answer for. Whether they ARE answerable is its call, not
# ours. Anything carrying whitespace or regex metacharacters stays out: a regex
# is not a term, and `\bfoo\b` is the documented escape hatch for searching
# anyway -- taking it away would leave no way out but abandoning the tool.
CANDIDATE_RE = re.compile(r"^[A-Za-z0-9_:./\-]{2,64}$")
HAS_LETTER_RE = re.compile(r"[A-Za-z]")

# Leading words that turn a two-word branch into a CONSTRUCTION SEARCH rather
# than prose -- the identifier after one of these is what normalize_branch
# reduces the branch to, below.
KEYWORD_HEADS = {
    "new", "class", "function", "def", "interface", "type", "struct", "enum",
    "extends", "implements", "import", "export", "const", "let", "var",
    "async", "await",
}

# An alternation (`tailKeep\|summaryKeep\|countKeep`) is not one pattern: each
# branch is asked about separately, otherwise a batch of indexed symbols
# joined by `\|` reads as free regex and never reaches the oracle (5 greps out
# of 5 escaped that way on one measured session). One uncovered branch lets
# the whole search run: that branch is work only grep can do. A branch
# carrying a regex metacharacter means a real regex, so the search passes
# untouched. A plain literal AiDex does not index (`id: "`) is a residue the
# refusal names, not a reason to give up on the covered branches.
REGEX_META_RE = re.compile(r"[*+?\[\]{}^$\\()]")

# Past this, it is not a list of identifiers any more, and each branch costs one
# process spawn.
MAX_BRANCHES = 12

# Search commands we recognise when run through the Bash tool.
GREP_CMDS = {"grep", "egrep", "fgrep", "rg", "ripgrep"}

# Commands whose default dialect is extended, where `|` alone means OR. For a
# bare `grep` the dialect is basic, where OR is `\|` and a lone `|` is literal --
# splitting on the wrong one would invent branches that do not exist.
ERE_CMDS = {"egrep", "rg", "ripgrep"}

# Tokens that introduce a new command position (a grep right after one counts).
CONNECTORS = {"|", "||", "&&", ";", "&", "|&"}

# Wrappers that precede a real command without changing "command position".
WRAPPERS = {"git", "sudo", "env", "time", "nice", "xargs", "command", "builtin",
            "doas", "nohup", "stdbuf"}

# Options whose VALUE is the search pattern.
PATTERN_OPTS = {"-e", "--regexp"}

# Options that consume the FOLLOWING token as their value (so it is not the
# positional pattern). Union of common grep + ripgrep value-taking flags.
VALUE_OPTS = {
    # grep
    "-f", "--file", "-m", "--max-count", "-A", "--after-context",
    "-B", "--before-context", "-C", "--context", "-d", "--devices",
    "-D", "--binary-files", "--include", "--exclude", "--exclude-dir",
    "--color", "--colour", "--group-separator", "--label",
    # ripgrep extras
    "-g", "--glob", "--iglob", "-t", "--type", "-T", "--type-not",
    "-M", "--max-columns", "--threads", "-j", "--colors", "--max-depth",
    "-E", "--encoding", "-r", "--replace", "--sort", "--sortr", "--pre",
    "--field-context-separator", "--field-match-separator", "-o",
}

# Flags that turn a search into a MEASUREMENT of presence or absence.
ABSENCE_LONG = {"--count", "--files-with-matches", "--files-without-match",
                "--quiet", "--silent"}
ABSENCE_SHORT = set("clLq")


def emit(payload):
    """Emit a PreToolUse hookSpecificOutput object and exit cleanly."""
    print(json.dumps({"hookSpecificOutput": payload}))
    sys.exit(0)


def noop():
    sys.exit(0)


def find_index_root(search_path, cwd):
    """Nearest ancestor of `search_path` carrying .aidex/index.db, or None.

    Both branches ascend, and neither ever did before. The Bash branch used to
    test the session cwd for an index directly -- true only when that cwd IS a
    project root, and blind both to a session opened one directory down and to a
    grep whose target a `cd` moved elsewhere. The Grep branch had it worse: the
    native Grep tool almost always scopes its search with a `path` pointing at a
    subdirectory or at a single file, and that same flat test then looked for an
    index inside the subdirectory -- or, for a file, inside its immediate parent
    -- where one was never going to be. The branch bailed out before reaching
    the oracle, so the hook was inert for that whole shape.

    Measured on 62 native Grep calls from one day of real transcripts: 54 of
    them, 87%, carried a `path` below the project root and were let through
    with no opinion, 42 of those in output_mode=content, which is exactly the
    lookup this hook exists to divert. Only 3 of 62 ever reached the oracle.
    What proves these were LOST blocks rather than correct passes: the oracle,
    asked directly about one of them, answered covered: true.

    Ascending is also what makes the file-scoped branch below reachable at all.
    """
    if os.path.isfile(search_path):
        search_path = os.path.dirname(search_path)
    if not os.path.isabs(search_path):
        # abspath() below would resolve a relative path against the HOOK
        # PROCESS's own cwd, not the session's cwd carried in the PreToolUse
        # payload -- those two differ whenever the hook runs under a
        # different working directory than the agent's session. Anchor on
        # the payload's cwd first so the two never disagree.
        search_path = os.path.join(cwd, search_path)
    search_path = os.path.abspath(search_path)
    while True:
        if os.path.isfile(os.path.join(search_path, ".aidex", "index.db")):
            return search_path
        parent = os.path.dirname(search_path)
        if parent == search_path:
            return None          # reached the filesystem root, no index above
        search_path = parent


def is_candidate_pattern(pattern):
    """Is this worth ASKING the oracle about? Never a decision to block."""
    return bool(
        pattern
        and CANDIDATE_RE.match(pattern)
        and HAS_LETTER_RE.search(pattern)
    )


def normalize_branch(branch):
    """`topN(` is a search for the CALL SITES of topN, not for another term.

    Stripping the trailing parenthesis is what makes the branch askable, and
    asking is the point: on the witness command it turned an opaque branch into
    `covered: true`, while on another grep of the same session it turned
    `prune(` into `prune`, `covered: false` -- which let that search through.
    Normalising made the hook MORE accurate in both directions, not just more
    aggressive.

    Same reasoning for `new Database`: a two-word branch shaped exactly
    `<keyword> <identifier>` is a search for the CONSTRUCTIONS of Database,
    not free-text prose, so it reduces to the identifier alone. Any other
    shape -- one word, three or more, or a leading word outside
    KEYWORD_HEADS -- is returned unchanged and falls through the existing
    non-candidate path downstream, exactly like any other pattern this
    function does not recognise.
    """
    branch = branch.strip()
    if branch.endswith("("):
        return branch[:-1]
    words = branch.split()
    if len(words) == 2 and words[0] in KEYWORD_HEADS:
        return words[1]
    return branch


def alternation_sep(base, tail):
    """Which token means OR in this invocation, or None when nothing does."""
    fixed = base == "fgrep"
    ere = base in ERE_CMDS
    for tok in tail:
        if tok in CONNECTORS:
            break
        if not tok.startswith("-") or tok == "-":
            continue
        if tok.startswith("--"):
            if tok == "--fixed-strings":
                fixed = True
            elif tok in ("--extended-regexp", "--perl-regexp"):
                ere = True
            continue
        letters = set(tok[1:])
        if "F" in letters:
            fixed = True
        if letters & {"E", "P"}:
            ere = True
    if fixed:
        return None          # -F: every character is literal, nothing to split
    return "|" if ere else "\\|"


def split_alternation(pattern, sep):
    """Branches of an alternation, or None when the split cannot be trusted.

    None is not "one branch": it means the shape is ambiguous, and the caller
    must let the search through.
    """
    if not pattern:
        return None
    if sep is None or sep not in pattern:
        return [pattern]
    parts = pattern.split(sep)
    if len(parts) > MAX_BRANCHES:
        return None
    if any(not part for part in parts):
        return None          # leading, trailing or doubled separator
    return parts


def classify_branches(branches):
    """Split branches into (askable, benign).

    `askable` holds the normalised branches the oracle can be asked about.
    `benign` is False as soon as ANY non-askable branch carries a regex
    metacharacter, which means the caller wrote a real regex and the search must
    run untouched.
    """
    askable = []
    for raw in branches:
        branch = normalize_branch(raw)
        if is_candidate_pattern(branch):
            askable.append(branch)
        elif REGEX_META_RE.search(branch):
            return [], False
    return askable, True


def enough_askable(branches, askable):
    """A single pattern only needs itself. An alternation needs at least two
    covered branches before a block is worth its risk: with one, the grep is
    mostly doing something else."""
    return len(askable) >= (1 if len(branches) == 1 else 2)


def resolve_cd(tokens, i, current_dir, cwd):
    """Where does this `cd` land? None when that is not statically knowable.

    `cd <path> && grep ...` was the shape suspected of defeating this hook, and
    it does not: `cd` is an ordinary command word and the `&&` after it puts the
    scan back at command position, so the grep was always seen. What WAS wrong
    is quieter -- the Bash branch judged the search against the session cwd, so
    a grep whose real target is another project got measured against the wrong
    index, or against none.
    """
    if i + 1 >= len(tokens):
        return None          # bare `cd`: goes home, and saying so is guessing
    target = tokens[i + 1]
    if target in CONNECTORS or target.startswith("-"):
        return None          # `cd -` and friends: unknowable from here
    if "$" in target or "`" in target:
        return None          # expansion: resolved by the shell, not by us
    target = os.path.expanduser(target)
    if not os.path.isabs(target):
        target = os.path.join(current_dir or cwd, target)
    return os.path.abspath(target)


def is_proof_of_absence(args):
    """Does this invocation measure presence rather than look something up?

    Counting matches, listing the files that match, or testing an exit status
    are not lookups: they are how you establish that something is NOT there.
    AiDex cannot do that -- its own refusal messages say so, and send the caller
    to grep for exactly this. Blocking it would contradict the advice the same
    system hands out.

    Scanning stops at the first connector, so a `-c` belonging to a LATER
    pipeline stage cannot disarm the guard for the stage being inspected --
    the same reasoning as the `-v` case below.
    """
    for tok in args:
        if tok in CONNECTORS:
            break
        if tok in ABSENCE_LONG:
            return True
        if tok.startswith("-") and not tok.startswith("--"):
            if ABSENCE_SHORT & set(tok[1:]):
                return True
    return False


def pipeline_counts(tokens):
    """Does the pipeline end up counting lines? `... | wc -l` is a proof of
    absence assembled from two commands instead of one flag."""
    for i, tok in enumerate(tokens):
        if os.path.basename(tok) == "wc" and "-l" in tokens[i + 1:i + 3]:
            return True
    return False


def ask_oracle(pattern, project_dir, target=None):
    """Ask the index whether it can answer this pattern. None on any failure.

    None is not "no": it is "no verdict", and the caller must let the search
    through. A broken oracle that silently blocked searches would be worse than
    no oracle at all.
    """
    if not os.path.isfile(AIDEX_ENTRY):
        return None

    args_tail = ["can", pattern, "--project", project_dir]
    if target:
        args_tail += ["--path", target]

    for node in NODE_CANDIDATES:
        if not node:
            continue
        try:
            proc = subprocess.run(
                [node, AIDEX_ENTRY] + args_tail,
                capture_output=True,
                timeout=ORACLE_TIMEOUT_S,
                text=True,
            )
        except Exception:
            continue          # this interpreter cannot run it -- try the next
        if proc.returncode != 0:
            # Exit code 0 means A VERDICT WAS PRODUCED, negative verdicts
            # included. Non-zero means no verdict at all, so there is nothing
            # to act on.
            continue
        try:
            verdict = json.loads(proc.stdout.strip().splitlines()[-1])
        except Exception:
            continue
        if isinstance(verdict, dict) and "covered" in verdict:
            return verdict
    return None


def collect_verdicts(patterns, project_dir, target=None):
    """Verdicts for every pattern, or [] as soon as one is not covered.

    The short-circuit is not just an optimisation: one uncovered branch is work
    that only grep can do, so there is nothing left to decide. It also keeps the
    cost of the common case down, since each pattern costs one process spawn.
    """
    verdicts = []
    for pattern in patterns:
        verdict = ask_oracle(pattern, project_dir, target)
        if not (verdict and verdict.get("covered")):
            return []
        verdicts.append((pattern, verdict))
    return verdicts


def refusal_text(verdicts, residual, source_hint):
    """Build the refusal FROM THE INDEX, never from numbers typed in here.

    An older version quoted a measurement copied by hand from a session on
    another repository. It was accurate the day it was written and unfalsifiable
    afterwards: nothing tied it to the index doing the refusing. Everything below
    comes from the verdicts the index just produced.

    `residual` matters as much as the block itself. Refusing a multi-term grep
    without saying which branches AiDex cannot answer would leave the caller
    with no way forward but to fight the tooling -- the exact outcome this whole
    mechanism exists to avoid. Naming them turns the refusal into instructions.
    """
    lines = []
    if len(verdicts) == 1:
        pattern, verdict = verdicts[0]
        rule = verdict.get("rule") or {}
        lines.append(
            f"AiDex can answer this search, so the grep is redundant: "
            f"'{pattern}' ({source_hint}) is covered by this project's index in "
            f"the {verdict.get('dimension')} dimension (schema "
            f"{verdict.get('schemaVersion')}, rule "
            f"{rule.get('id')}@{rule.get('version')})."
        )
    else:
        covered = ", ".join(
            f"'{p}' ({v.get('dimension')})" for p, v in verdicts
        )
        lines.append(
            f"AiDex can answer this search, so the grep is redundant: every "
            f"indexable branch of this alternation ({source_hint}) is covered "
            f"by this project's index -- {covered}."
        )
    for pattern, verdict in verdicts:
        kinds_hint = (
            'kinds: ["literal"]' if verdict.get("dimension") == "literal"
            else "the default kinds"
        )
        lines.append(
            f"Use mcp__aidex__aidex_query (term: '{pattern}', {kinds_hint})."
        )
    if residual:
        lines.append(
            "These branches are NOT indexable and stay yours: "
            + ", ".join(f"'{r}'" for r in residual)
            + " -- re-run the grep with those alone."
        )
    lines.append(
        "To check presence or absence, Grep with output_mode count or "
        "files_with_matches (grep -c or -l via Bash) is never blocked."
    )
    return "\n".join(lines)


def extract_grep_pattern(args):
    """Given the argv tail after a grep/rg command word, return the search
    pattern (string) or None. Honours -e/--regexp, skips option values."""
    i = 0
    n = len(args)
    # An INVERTED match is an exclusion filter, never a symbol lookup: the
    # canonical shape is `<real search> | grep -v <noise>`, where the noise word
    # (node_modules, dist, test) is a bare identifier and would trip this guard
    # on behalf of a pipeline stage that searches for nothing. Bail out before
    # looking for a pattern at all. Bundled forms count (-rv, -iv), so this
    # inspects the letters of every short flag, not just the exact token "-v".
    for tok in args:
        if tok in CONNECTORS:
            break  # only this subcommand's own flags matter
        if tok == "--invert-match":
            return None
        if tok.startswith("-") and not tok.startswith("--") and "v" in tok[1:]:
            return None
    while i < n:
        tok = args[i]
        if tok in CONNECTORS:
            break  # end of this subcommand
        if tok in PATTERN_OPTS:
            return args[i + 1] if i + 1 < n else None
        if tok.startswith("--") and "=" in tok:
            key, val = tok.split("=", 1)
            if key in PATTERN_OPTS:
                return val
            i += 1
            continue
        if tok in VALUE_OPTS:
            i += 2  # skip the option and its value
            continue
        if tok.startswith("-") and tok != "-":
            i += 1  # boolean / bundled flag
            continue
        # First bare positional argument is the search pattern.
        return tok
    return None


def find_bash_search(command, cwd):
    """Scan a Bash command line for a grep/rg invocation worth asking about.

    Returns {"patterns", "residual", "dir"} or None when there is nothing to
    ask -- including when the invocation is a proof of absence, which is a
    legitimate use of grep that AiDex cannot replace.

    `dir` is where the grep will actually RUN, which is the session cwd only
    until a `cd` says otherwise.
    """
    try:
        tokens = shlex.split(command)
    except ValueError:
        return None  # unbalanced quotes etc. -- leave it alone

    counts_lines = pipeline_counts(tokens)

    current_dir = cwd
    at_command_pos = True
    i = 0
    n = len(tokens)
    while i < n:
        tok = tokens[i]
        if tok in CONNECTORS:
            at_command_pos = True
            i += 1
            continue
        if at_command_pos:
            base = os.path.basename(tok)
            if base in WRAPPERS or "=" in tok and tok.split("=", 1)[0].isidentifier():
                # wrapper or leading VAR=val assignment -> stay at command pos
                i += 1
                continue
            if base == "cd":
                moved = resolve_cd(tokens, i, current_dir, cwd)
                if moved is None:
                    return None      # unknown target -> judge nothing
                current_dir = moved
                i += 2
                at_command_pos = False
                continue
            if base in GREP_CMDS:
                tail = tokens[i + 1:]
                if is_proof_of_absence(tail) or counts_lines:
                    return None
                pattern = extract_grep_pattern(tail)
                branches = split_alternation(
                    pattern, alternation_sep(base, tail)
                )
                if branches:
                    askable, benign = classify_branches(branches)
                    if benign and enough_askable(branches, askable):
                        residual = [
                            b for b in branches
                            if normalize_branch(b) not in askable
                        ]
                        return {"patterns": askable, "residual": residual,
                                "dir": current_dir}
                # a grep we could not pin to a candidate -> keep scanning the
                # rest of the pipeline for another search
                at_command_pos = False
                i += 1
                continue
            # some other command word
            at_command_pos = False
            i += 1
            continue
        i += 1
    return None


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        noop()

    tool = data.get("tool_name")
    tool_input = data.get("tool_input") or {}
    cwd = data.get("cwd") or os.getcwd()

    if tool == "Grep":
        pattern = tool_input.get("pattern")
        if not isinstance(pattern, str) or not pattern:
            noop()
        # `output_mode` makes the intent explicit: counting matches or listing
        # the files that hold them measures presence, it does not look a symbol
        # up. Same reasoning as grep -c / -l on the Bash side.
        if tool_input.get("output_mode") in ("count", "files_with_matches"):
            noop()
        search_path = tool_input.get("path") or cwd
        # The index lives at the PROJECT ROOT, while `path` scopes the search
        # anywhere below it. Ascend to find the one from the other; None means
        # this search happens outside any indexed project, so leave it alone.
        project_dir = find_index_root(search_path, cwd)
        if not project_dir:
            noop()  # no AiDex index above this path -- leave the search alone
        # The native Grep tool runs ripgrep, so its alternation separator is a
        # bare `|`. Same policy as the Bash branch: split, ask about every
        # indexable branch, block only when none of them is missing.
        branches = split_alternation(pattern, "|")
        if not branches:
            noop()
        askable, benign = classify_branches(branches)
        if not benign or not enough_askable(branches, askable):
            noop()  # free text / regex -> legitimate Grep, never intercept
        residual = [b for b in branches if normalize_branch(b) not in askable]
        # A FILE scope is handed to the oracle: it answers `path_out_of_scope`
        # or `index_stale_on_file`, neither of which may block. A DIRECTORY
        # scope is not: the oracle matches indexed FILES and would answer
        # `path_out_of_scope` for every directory. A search scoped to an
        # excluded subtree is therefore judged against the whole project
        # (0 of 62 calls on the reference corpus). No exclusion list is copied
        # here: AiDex derives its own from DEFAULT_EXCLUDE plus each project's
        # .gitignore/.aidexignore, and a copy would drift. The fix belongs in
        # the oracle: accept a directory as a path PREFIX.
        is_file = os.path.isfile(search_path)
        target = search_path if is_file else None
        verdicts = collect_verdicts(askable, project_dir, target)
        if verdicts:
            emit({
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": refusal_text(
                    verdicts, residual, "Grep tool"),
            })
        noop()  # no verdict, or a verdict that does not justify a block

    elif tool == "Bash":
        command = tool_input.get("command")
        if not isinstance(command, str) or not command:
            noop()
        found = find_bash_search(command, cwd)
        if not found:
            noop()
        # Ascend from where the grep will RUN, not from the session cwd: those
        # differ as soon as the command starts with a `cd`, and they also differ
        # for a session opened in a subdirectory of its own project -- a case
        # the old has_index(cwd) silently dropped.
        project_dir = find_index_root(found["dir"], cwd)
        if not project_dir:
            noop()  # no AiDex index above the target -- leave the search alone
        verdicts = collect_verdicts(found["patterns"], project_dir)
        if verdicts:
            emit({
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": refusal_text(
                    verdicts, found["residual"], "grep/rg via Bash"),
            })
        noop()

    noop()


if __name__ == "__main__":
    main()
