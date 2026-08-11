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
# tree-sitter), so a `node` from a different major aborts on
# NODE_MODULE_VERSION before producing anything -- on this machine the PATH
# `node` is exactly that, which is why the configured one comes first. An
# explicit override wins over discovery; `node` is the last resort, useful when
# only AIDEX_ENTRY is set. Candidates are tried in order, and if none yields a
# verdict the search passes.
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

# Search commands we recognise when run through the Bash tool.
GREP_CMDS = {"grep", "egrep", "fgrep", "rg", "ripgrep"}

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


def has_index(search_path):
    if os.path.isfile(search_path):
        search_path = os.path.dirname(search_path)
    return os.path.isfile(os.path.join(search_path, ".aidex", "index.db"))


def is_candidate_pattern(pattern):
    """Is this worth ASKING the oracle about? Never a decision to block."""
    return bool(
        pattern
        and CANDIDATE_RE.match(pattern)
        and HAS_LETTER_RE.search(pattern)
    )


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


def refusal_text(pattern, verdict, source_hint):
    """Build the refusal FROM THE INDEX, never from numbers typed in here.

    The previous version quoted a measurement copied by hand from a session on
    another repository. It was accurate the day it was written and unfalsifiable
    afterwards: nothing tied it to the index doing the refusing. Everything below
    comes from the verdict the index just produced.
    """
    dimension = verdict.get("dimension")
    rule = verdict.get("rule") or {}
    kinds_hint = (
        'kinds: ["literal"]' if dimension == "literal" else "the default kinds"
    )
    return (
        f"AiDex can answer this search, so the grep is redundant: '{pattern}' "
        f"({source_hint}) is covered by this project's index in the "
        f"{dimension} dimension (schema {verdict.get('schemaVersion')}, rule "
        f"{rule.get('id')}@{rule.get('version')}).\n"
        f"Use mcp__aidex__aidex_query (term: '{pattern}', {kinds_hint}).\n"
        f"This index DECLARES coverage for this pattern, which is what makes a "
        f"zero from it meaningful: it means absent, not unindexed. That is the "
        f"only case where this hook blocks -- every other verdict, and every "
        f"failure to obtain one, lets the search run.\n"
        f"To prove an absence rather than find an occurrence, use grep with -c, "
        f"-l or a trailing `wc -l`: those are never blocked."
    )


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


def find_bash_search(command):
    """Scan a Bash command line for a grep/rg invocation worth asking about.

    Returns the pattern, or None when there is nothing to ask -- including when
    the invocation is a proof of absence, which is a legitimate use of grep that
    AiDex cannot replace.
    """
    try:
        tokens = shlex.split(command)
    except ValueError:
        return None  # unbalanced quotes etc. -- leave it alone

    counts_lines = pipeline_counts(tokens)

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
            if base in GREP_CMDS:
                tail = tokens[i + 1:]
                if is_proof_of_absence(tail) or counts_lines:
                    return None
                pattern = extract_grep_pattern(tail)
                if is_candidate_pattern(pattern):
                    return pattern
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
        if not has_index(search_path):
            noop()  # no AiDex index here -- leave the search alone
        if not is_candidate_pattern(pattern):
            noop()  # free text / regex -> legitimate Grep, never intercept
        # When the search is scoped to a FILE, hand that file to the oracle: it
        # answers `path_out_of_scope` for a file the index never saw and
        # `index_stale_on_file` for one that changed since. Both are verdicts
        # that must not block, and neither is knowable from the pattern alone.
        is_file = os.path.isfile(search_path)
        project_dir = os.path.dirname(search_path) if is_file else search_path
        verdict = ask_oracle(pattern, project_dir, search_path if is_file else None)
        if verdict and verdict.get("covered"):
            emit({
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": refusal_text(pattern, verdict, "Grep tool"),
            })
        noop()  # no verdict, or a verdict that does not justify a block

    elif tool == "Bash":
        command = tool_input.get("command")
        if not isinstance(command, str) or not command:
            noop()
        if not has_index(cwd):
            noop()  # session cwd has no index -- leave Bash alone
        pattern = find_bash_search(command)
        if not pattern:
            noop()
        verdict = ask_oracle(pattern, cwd)
        if verdict and verdict.get("covered"):
            emit({
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": refusal_text(pattern, verdict, "grep/rg via Bash"),
            })
        noop()

    noop()


if __name__ == "__main__":
    main()
