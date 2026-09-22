"""Portable probes for the versioned aidex-grep-nudge hook."""

import importlib.util
import io
import json
import os
import re
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HOOK = os.path.join(REPO_ROOT, "hooks", "claude", "aidex-grep-nudge.py")


spec = importlib.util.spec_from_file_location("aidex_grep_nudge", HOOK)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


SYMBOL = {"dimension": "symbol", "schemaVersion": "1.5", "rule": {"id": "strict", "version": 2}}
LITERAL = dict(SYMBOL, dimension="literal")
GREP_LINE = (
    "To check presence or absence, Grep with output_mode count or files_with_matches "
    "(grep -c or -l via Bash) is never blocked."
)


checks = 0


def check(label, actual, expected):
    global checks
    checks += 1
    ok = actual == expected
    print("%s %s" % ("PASS" if ok else "FAIL", label))
    if not ok:
        print("  received: %r" % (actual,))
        print("  expected: %r" % (expected,))
    return 0 if ok else 1


def refusal_contract_problems(text):
    quoted = r"'[^'\n]{1,80}'"
    source = r"\((?:Grep tool|grep/rg via Bash)\)"
    dimension = r"(?:symbol|literal)"
    forms = (
        re.compile(
            r"AiDex can answer this search, so the grep is redundant: "
            + quoted + " " + source + r" is covered by this project's index in the "
            + dimension + r" dimension \(schema [\w.]{1,10}, rule [\w+.-]{1,40}@\w{1,10}\)\."
        ),
        re.compile(
            r"AiDex can answer this search, so the grep is redundant: every indexable branch of "
            r"this alternation " + source + r" is covered by this project's index -- "
            + quoted + r" \(" + dimension + r"\)(?:, " + quoted + r" \(" + dimension + r"\))+\."
        ),
        re.compile(
            r"Use mcp__aidex__aidex_query \(term: " + quoted
            + r", (?:kinds: \[\"literal\"\]|the default kinds)\)\."
        ),
        re.compile(
            r"These branches are NOT indexable and stay yours: " + quoted
            + r"(?:, " + quoted + r")* -- re-run the grep with those alone\."
        ),
    )
    shape = []
    problems = []
    for line in text.splitlines():
        if line == GREP_LINE:
            shape.append("g")
        elif forms[0].fullmatch(line) or forms[1].fullmatch(line):
            shape.append("h")
        elif forms[2].fullmatch(line):
            shape.append("q")
        elif forms[3].fullmatch(line):
            shape.append("r")
        else:
            problems.append("unknown line: %s" % line)
            shape.append("?")
    if not re.fullmatch(r"hq+r?g", "".join(shape)):
        problems.append("unexpected refusal shape: %s" % "".join(shape))
    return problems


def invoke_main(payload, replacements):
    saved_stdin = module.sys.stdin
    saved_stdout = module.sys.stdout
    saved = {name: getattr(module, name) for name in replacements}
    module.sys.stdin = io.StringIO(json.dumps(payload))
    module.sys.stdout = io.StringIO()
    for name, replacement in replacements.items():
        setattr(module, name, replacement)
    try:
        try:
            module.main()
        except SystemExit as error:
            if error.code != 0:
                raise
        return module.sys.stdout.getvalue()
    finally:
        module.sys.stdin = saved_stdin
        module.sys.stdout = saved_stdout
        for name, original in saved.items():
            setattr(module, name, original)


def main():
    failures = 0

    extract_grep_pattern_cases = [
        (["-rn", "restoreSessions", "src/"], "restoreSessions", "plain lookup is detected"),
        (["-e", "restoreSessions"], "restoreSessions", "-e form is detected"),
        (["--regexp=restoreSessions"], "restoreSessions", "--regexp= form is detected"),
        (["restoreSessions"], "restoreSessions", "bare pattern with no flags is detected"),
        (["-v", "node_modules"], None, "plain -v is skipped"),
        (["-rv", "node_modules"], None, "bundled -rv is skipped"),
        (["-iv", "dist"], None, "bundled -iv is skipped"),
        (["--invert-match", "dist"], None, "long --invert-match is skipped"),
        (["-rn", "restoreSessions", "src/", "|", "grep", "-v", "test"],
         "restoreSessions", "a later -v does not disarm this stage"),
    ]
    for args, expected, label in extract_grep_pattern_cases:
        failures += check(label, module.extract_grep_pattern(args), expected)

    candidate_pattern_cases = [
        ("restoreSessions", True, "bare identifier stays a candidate"),
        ("sandbox:changed", True, "separator pattern is a candidate since schema 1.3"),
        ("config.json", True, "dotted literal is a candidate"),
        ("restore-prev", True, "hyphenated literal is a candidate"),
        (r"\brestoreSessions\b", False, "word-boundary regex is the documented escape hatch"),
        ("hello world", False, "free text is never asked about"),
        ("foo.*bar", False, "regex metacharacters are never asked about"),
        ("__", False, "a pattern with no letter is not asked about"),
        ("x", False, "a single character is not asked about"),
    ]
    for pattern, expected, label in candidate_pattern_cases:
        failures += check(label, module.is_candidate_pattern(pattern), expected)

    expected_search = {
        "patterns": ["handleToolCall"],
        "residual": [],
        "dir": REPO_ROOT,
    }
    two_symbols = {
        "patterns": ["handleToolCall", "DEFAULT_DISABLED_TOOLS"],
        "residual": [],
        "dir": REPO_ROOT,
    }
    bash_cases = [
        ("grep -n handleToolCall src/server/tools.ts", expected_search, "plain lookup"),
        ("grep -c handleToolCall src/server/tools.ts", None, "count is proof of absence"),
        ("grep -l handleToolCall src/server/tools.ts", None, "-l lists files, it does not look up"),
        ("grep -L handleToolCall src/server/tools.ts", None, "-L lists non-matching files"),
        ("grep -q handleToolCall src/server/tools.ts", None, "-q tests an exit status"),
        ("grep --count handleToolCall src/server/tools.ts", None, "long --count form"),
        ("grep --files-with-matches handleToolCall src/server/tools.ts", None, "long files-with-matches form"),
        ("grep --files-without-match handleToolCall src/server/tools.ts", None, "long files-without-match form"),
        ("grep --quiet handleToolCall src/server/tools.ts", None, "long quiet form"),
        ("grep --silent handleToolCall src/server/tools.ts", None, "long silent form"),
        ("grep -rl handleToolCall src/server/tools.ts", None, "bundled -rl is also proof of absence"),
        ("grep -n handleToolCall src/server/tools.ts | wc -l", None, "line count is proof of absence"),
        ("cat src/server/tools.ts", None, "a command that is not a search"),
        ("grep -n 'hello world' src/server/tools.ts", None, "free text is left alone"),
        ("rg -n 'handleToolCall|DEFAULT_DISABLED_TOOLS|literal text' src/server/tools.ts", {
            "patterns": ["handleToolCall", "DEFAULT_DISABLED_TOOLS"],
            "residual": ["literal text"],
            "dir": REPO_ROOT,
        }, "residual branch stays visible"),
        ("grep -n 'handleToolCall|other.*term' src/server/tools.ts", None, "regex metacharacter branch passes through"),
        (r"fgrep -n 'handleToolCall\|DEFAULT_DISABLED_TOOLS' src/server/tools.ts", None, "fgrep keeps pipe literal"),
        (r"grep -F -n 'handleToolCall\|DEFAULT_DISABLED_TOOLS' src/server/tools.ts", None, "grep -F keeps pipe literal"),
        ("grep -E -n 'handleToolCall|DEFAULT_DISABLED_TOOLS' src/server/tools.ts", two_symbols, "grep -E splits a bare pipe"),
        ("grep -n 'handleToolCall|DEFAULT_DISABLED_TOOLS' src/server/tools.ts", None, "grep BRE keeps a bare pipe literal"),
        ("grep -v handleToolCall src/server/tools.ts", None, "grep -v passes through"),
        (r"grep -n 'handleToolCall\|DEFAULT_DISABLED_TOOLS' src/server/tools.ts", two_symbols, "grep BRE splits an escaped pipe"),
        ("cd src && grep -n handleToolCall server/tools.ts", {
            "patterns": ["handleToolCall"], "residual": [], "dir": os.path.join(REPO_ROOT, "src")
        }, "cd changes the search directory"),
        ("grep -n handleToolCall src/server/tools.ts | grep -v test", expected_search,
         "a later -v stage does not disarm the first"),
    ]
    for command, expected, label in bash_cases:
        failures += check(label, module.find_bash_search(command, REPO_ROOT), expected)

    for verdicts, residual, source_hint, label in [
        ([("handleToolCall", SYMBOL)], [], "Grep tool", "single symbol refusal"),
        ([("handleToolCall", SYMBOL), ("settings.restoreSessions", LITERAL)], ["id: \""], "grep/rg via Bash", "mixed alternation refusal"),
    ]:
        text = module.refusal_text(verdicts, residual, source_hint)
        failures += check(label, refusal_contract_problems(text), [])

    with tempfile.TemporaryDirectory() as root:
        nested = os.path.join(root, "src", "nested")
        os.makedirs(nested)
        os.makedirs(os.path.join(root, ".aidex"))
        target = os.path.join(nested, "probe.ts")
        open(os.path.join(root, ".aidex", "index.db"), "w", encoding="utf-8").close()
        open(target, "w", encoding="utf-8").close()
        failures += check("find_index_root ascends from a file", module.find_index_root(target, nested), root)
        failures += check("find_index_root ascends from a nested directory", module.find_index_root(nested, nested), root)

    calls = []
    payload = {
        "tool_name": "Grep",
        "tool_input": {"pattern": "handleToolCall", "path": os.path.join(REPO_ROOT, "src")},
        "cwd": REPO_ROOT,
    }
    output = invoke_main(payload, {
        "find_index_root": lambda search_path, cwd: REPO_ROOT,
        "collect_verdicts": lambda patterns, project_dir, target=None: calls.append((patterns, project_dir, target)) or [("handleToolCall", SYMBOL)],
    })
    decision = json.loads(output)["hookSpecificOutput"] if output else None
    failures += check("native Grep delegates through collect_verdicts", calls, [(["handleToolCall"], REPO_ROOT, None)])
    failures += check("native Grep denial follows the refusal contract", refusal_contract_problems(decision["permissionDecisionReason"]), [])

    no_verdict_output = invoke_main({
        "tool_name": "Grep",
        "tool_input": {"pattern": "handleToolCall"},
        "cwd": REPO_ROOT,
    }, {
        "find_index_root": lambda search_path, cwd: REPO_ROOT,
        "collect_verdicts": lambda *args: [],
    })
    failures += check("native Grep passes when no covered verdict is available", no_verdict_output, "")

    for output_mode in ("count", "files_with_matches"):
        no_oracle_output = invoke_main({
            "tool_name": "Grep",
            "tool_input": {"pattern": "handleToolCall", "output_mode": output_mode},
            "cwd": REPO_ROOT,
        }, {
            "find_index_root": lambda search_path, cwd: (_ for _ in ()).throw(AssertionError("must not find an index")),
            "collect_verdicts": lambda *args: (_ for _ in ()).throw(AssertionError("must not call oracle")),
        })
        failures += check("native Grep %s passes without oracle" % output_mode, no_oracle_output, "")

    portability_markers = [r"[A-Za-z]:[\\/]", "Oliv" + "ier", "DESK" + "TOP-"]
    portability_sources = [
        open(path, encoding="utf-8").read()
        for path in (HOOK, __file__)
    ]
    failures += check("hook and test have no local path or machine marker", [
        marker for marker in portability_markers
        if any(re.search(marker, source) for source in portability_sources)
    ], [])

    print("\n%d/%d green" % (checks - failures, checks))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
