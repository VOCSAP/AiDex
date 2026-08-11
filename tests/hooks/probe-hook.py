"""End-to-end probe of the Lot 5 hook against the LIVE oracle.

Feeds real PreToolUse payloads to the hook and prints the decision, so the
blocking behaviour is observed rather than reasoned about.
"""
import json
import os
import subprocess
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HOOK = os.path.join(REPO_ROOT, "hooks", "aidex-grep-nudge.py")
# This repository is itself an indexed project, so it doubles as the fixture.
AIDEX = REPO_ROOT
# A fresh temp directory has no .aidex, which is the "no index here" case.
NO_INDEX = tempfile.mkdtemp(prefix="aidex-noindex-")

CASES = [
    ("symbole couvert", "Bash", AIDEX, {"command": "grep -rn literalQualifies src/"}),
    ("literal couvert (separateur)", "Bash", AIDEX, {"command": "grep -rn restore-prev src/"}),
    ("mot minuscule sous la regle", "Bash", AIDEX, {"command": "grep -rn ok src/"}),
    ("preuve d'absence: -c", "Bash", AIDEX, {"command": "grep -c literalQualifies src/commands/query.ts"}),
    ("preuve d'absence: -l", "Bash", AIDEX, {"command": "grep -rl literalQualifies src/"}),
    ("preuve d'absence: | wc -l", "Bash", AIDEX, {"command": "grep -rn literalQualifies src/ | wc -l"}),
    ("exclusion: grep -v", "Bash", AIDEX, {"command": "ls | grep -v node_modules"}),
    ("regex bordure de mot", "Bash", AIDEX, {"command": r"grep -rn '\bliteralQualifies\b' src/"}),
    ("texte libre", "Bash", AIDEX, {"command": "grep -rn 'hello world' src/"}),
    ("projet sans index", "Bash", NO_INDEX, {"command": "grep -rn literalQualifies ."}),
    ("Grep tool, symbole couvert", "Grep", AIDEX, {"pattern": "literalQualifies", "path": AIDEX}),
    ("Grep tool, output_mode=count", "Grep", AIDEX,
     {"pattern": "literalQualifies", "output_mode": "count", "path": AIDEX}),
]

fail = 0
for label, tool, cwd, tool_input in CASES:
    payload = json.dumps({"tool_name": tool, "cwd": cwd, "tool_input": tool_input})
    proc = subprocess.run([sys.executable, HOOK], input=payload, capture_output=True, text=True)
    out = proc.stdout.strip()
    if not out:
        decision = "allow (silence)"
    else:
        try:
            decision = json.loads(out)["hookSpecificOutput"]["permissionDecision"]
        except Exception:
            decision = "UNPARSEABLE: " + out[:80]
            fail += 1
    if proc.returncode != 0:
        decision += f"  [exit {proc.returncode}] {proc.stderr.strip()[:120]}"
        fail += 1
    print(f"{label:34} -> {decision}")

# Show one full refusal, to check the text is built from the index.
payload = json.dumps({"tool_name": "Bash", "cwd": AIDEX,
                      "tool_input": {"command": "grep -rn restore-prev src/"}})
proc = subprocess.run([sys.executable, HOOK], input=payload, capture_output=True, text=True)
if proc.stdout.strip():
    try:
        print("\n--- texte de refus ---")
        print(json.loads(proc.stdout)["hookSpecificOutput"]["permissionDecisionReason"])
    except Exception:
        pass

sys.exit(1 if fail else 0)
