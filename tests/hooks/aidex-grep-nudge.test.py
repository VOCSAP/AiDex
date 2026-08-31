"""Probes for aidex-grep-nudge.py.

Run: python tests/hooks/aidex-grep-nudge.test.py   (exit 0 = all green)

Why this file exists. The nudge hook decides whether a Bash `grep` is a SYMBOL
LOOKUP (worth diverting to AiDex) or something else. Both halves of that decision
have failed in the field, so both are pinned here:

  * SENSITIVITY -- it must still fire on a real bare-identifier lookup. Easy to
    keep, easy to test, and the half everyone tests.
  * FALSE POSITIVES -- `... | grep -v node_modules` is an EXCLUSION filter at the
    end of a pipeline. It searches for nothing, yet its argument is a bare
    identifier, so the guard used to block the whole command on behalf of a stage
    that was not looking anything up. Measured live on 2026-08-10: a
    `grep -rln "bare identifier" DIR | grep -v node_modules` was refused because
    of `node_modules`. That is the red these probes were written against.

Keep the two groups together: a fix that silences the false positives by loosening
the bare-identifier test would pass group 2 and quietly gut group 1.

Since Lot 5 the hook no longer decides to block on its own -- it asks the coverage
oracle and blocks only on `covered: true`. What is pinned here is therefore what
it ASKS about and what it never asks about; the blocking decision itself belongs
to the oracle's own differential test, in the AiDex repo.
"""

import importlib.util
import os
import sys

# The hook under test is the copy VERSIONED IN THIS REPO, not the one installed
# in the user profile. The installed copy is a deployment of this file; testing
# it instead would green-light a file nobody reviews.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HOOK = os.path.join(REPO_ROOT, "hooks", "claude", "aidex-grep-nudge.py")

spec = importlib.util.spec_from_file_location("aidex_grep_nudge", HOOK)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
extract_grep_pattern = module.extract_grep_pattern
is_candidate_pattern = module.is_candidate_pattern
find_bash_search = module.find_bash_search

# (argv tail after the grep/rg command word, expected pattern, what it pins)
CASES = [
    # Group 1 -- sensitivity: a genuine lookup must still be detected.
    (["-rn", "restoreSessions", "src/"], "restoreSessions", "plain lookup is detected"),
    (["-e", "restoreSessions"], "restoreSessions", "-e form is detected"),
    (["--regexp=restoreSessions"], "restoreSessions", "--regexp= form is detected"),
    (["restoreSessions"], "restoreSessions", "bare pattern with no flags is detected"),

    # Group 2 -- inverted matches are exclusion filters, never lookups.
    (["-v", "node_modules"], None, "plain -v is skipped"),
    (["-rv", "node_modules"], None, "bundled -rv is skipped"),
    (["-iv", "dist"], None, "bundled -iv is skipped"),
    (["--invert-match", "dist"], None, "long --invert-match is skipped"),

    # Group 3 -- an invert flag belonging to a LATER pipeline stage must not
    # disarm the guard for the stage being inspected. CONNECTORS end the scan.
    (["-rn", "restoreSessions", "src/", "|", "grep", "-v", "test"],
     "restoreSessions", "a later -v does not disarm this stage"),
]

# What the pre-filter is willing to ASK about. Widening this is the ONLY
# sanctioned direction of change: the oracle, not this file, decides to block.
CANDIDATE_CASES = [
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

# Proof of absence: measuring presence is not looking something up, and AiDex
# says so itself when it sends a caller to grep. Blocking these would
# contradict the advice the same system hands out.
BASH_CASES = [
    ("grep -rn restoreSessions src/", "restoreSessions", "plain search is asked about"),
    ("grep -c restoreSessions src/app.ts", None, "-c counts, it does not look up"),
    ("grep -l restoreSessions src/", None, "-l lists files, it does not look up"),
    ("grep -L restoreSessions src/", None, "-L lists non-matching files"),
    ("grep -q restoreSessions src/app.ts", None, "-q tests an exit status"),
    ("grep --count restoreSessions src/", None, "long --count form"),
    ("grep -rn restoreSessions src/ | wc -l", None, "a trailing wc -l counts lines"),
    ("grep -rn restoreSessions src/ | grep -v test", "restoreSessions",
     "a later -v stage does not disarm the first"),
    ("rg sandbox:changed", "sandbox:changed", "ripgrep on a literal is asked about"),
    ("cat foo.txt", None, "a command that is not a search"),
    ("grep -rn 'hello world' src/", None, "free text is left alone"),
]


def main():
    failures = 0
    for args, expected, label in CASES:
        actual = extract_grep_pattern(args)
        ok = actual == expected
        failures += 0 if ok else 1
        print("%s %s -> %r (expected %r)" % ("PASS" if ok else "FAIL", label, actual, expected))

    for pattern, expected, label in CANDIDATE_CASES:
        actual = is_candidate_pattern(pattern)
        ok = actual == expected
        failures += 0 if ok else 1
        print("%s %s -> %r (expected %r)" % ("PASS" if ok else "FAIL", label, actual, expected))

    for command, expected, label in BASH_CASES:
        actual = find_bash_search(command)
        ok = actual == expected
        failures += 0 if ok else 1
        print("%s %s -> %r (expected %r)" % ("PASS" if ok else "FAIL", label, actual, expected))

    total = len(CASES) + len(CANDIDATE_CASES) + len(BASH_CASES)
    print("\n%d/%d green" % (total - failures, total))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
