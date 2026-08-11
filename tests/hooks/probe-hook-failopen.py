"""Fail-open contract: no oracle, no verdict, no block.

Each case breaks the oracle a different way and asserts the search still runs.
The control case proves the same payload DOES block when the oracle answers, so
a green run cannot come from a payload that was broken all along -- which is
exactly how the first attempt at this probe fooled itself, feeding the hook JSON
with an invalid escape and reading four passes as four fail-opens.
"""
import json
import os
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HOOK = os.path.join(REPO_ROOT, "hooks", "aidex-grep-nudge.py")
PAYLOAD = json.dumps({
    "tool_name": "Bash",
    "cwd": REPO_ROOT,
    "tool_input": {"command": "grep -rn literalQualifies src/"},
})

CASES = [
    ("control: oracle reachable", {}, "deny"),
    ("AiDex entry missing", {"AIDEX_ENTRY": r"C:\nope\index.js"}, "allow"),
    ("interpreter missing", {"AIDEX_NODE": r"C:\nope\node.exe",
                             "AIDEX_ENTRY": r"C:\nope\index.js"}, "allow"),
    ("entry present but not AiDex", {"AIDEX_ENTRY": os.path.abspath(__file__)}, "allow"),
    ("timeout budget of zero", {"AIDEX_TIMEOUT_S": "0"}, "allow"),
]

fail = 0
for label, extra_env, expected in CASES:
    env = dict(os.environ)
    env.update(extra_env)
    proc = subprocess.run([sys.executable, HOOK], input=PAYLOAD,
                          capture_output=True, text=True, env=env)
    out = proc.stdout.strip()
    if not out:
        actual = "allow"
    else:
        try:
            actual = json.loads(out)["hookSpecificOutput"]["permissionDecision"]
        except Exception:
            actual = "UNPARSEABLE"
    ok = actual == expected
    fail += 0 if ok else 1
    print(f"{'PASS' if ok else 'FAIL'} {label:32} -> {actual} (expected {expected})")
    if proc.returncode != 0:
        print(f"     exit {proc.returncode}: {proc.stderr.strip()[:150]}")

# A malformed payload must also pass, silently.
proc = subprocess.run([sys.executable, HOOK], input='{"tool_name": "Bash", "cwd": "D:\\AI"}',
                      capture_output=True, text=True)
ok = proc.stdout.strip() == "" and proc.returncode == 0
fail += 0 if ok else 1
print(f"{'PASS' if ok else 'FAIL'} {'unreadable payload':32} -> "
      f"{'allow' if ok else proc.stdout.strip()[:60]} (expected allow)")

print(f"\n{len(CASES) + 1 - fail}/{len(CASES) + 1} green")
sys.exit(1 if fail else 0)
