"""aidex-init-nudge.py end to end: real SessionStart payloads on stdin, the hook
run as its own process, fixture directories built in the OS temp dir.

AIDEX_ENTRY is pinned per run, to an existing file or to a missing one, so the
verdict never depends on the MCP declaration of the machine running the test.

Fixture directories are left in the OS temp dir.
"""
import json
import os
import re
import subprocess
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HOOK = os.path.join(REPO_ROOT, "hooks", "claude", "aidex-init-nudge.py")

BASE = tempfile.mkdtemp(prefix="aidex-init-nudge-")
FAKE_ENTRY = os.path.join(BASE, "index.js")
with open(FAKE_ENTRY, "w", encoding="utf-8") as fh:
    fh.write("// stand-in entry point\n")
MISSING_ENTRY = os.path.join(BASE, "missing", "index.js")


def make_dir(*parts):
    path = os.path.join(BASE, *parts)
    os.makedirs(path, exist_ok=True)
    return path


def touch(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("")


GIT_ROOT = make_dir("git-root")
make_dir("git-root", ".git")
GIT_SUBDIR = make_dir("git-root", "src")

WORKTREE = make_dir("worktree")
with open(os.path.join(WORKTREE, ".git"), "w", encoding="utf-8") as fh:
    fh.write("gitdir: elsewhere\n")

INDEXED = make_dir("indexed")
make_dir("indexed", ".git")
touch(os.path.join(INDEXED, ".aidex", "index.db"))

EMPTY_AIDEX = make_dir("empty-aidex")
make_dir("empty-aidex", ".git")
make_dir("empty-aidex", ".aidex")

PLAIN = make_dir("plain")


def run_hook(stdin_text, entry=FAKE_ENTRY):
    env = dict(os.environ)
    env["AIDEX_ENTRY"] = entry
    env["AIDEX_NODE"] = "node"
    proc = subprocess.run([sys.executable, HOOK], input=stdin_text, capture_output=True,
                          text=True, cwd=PLAIN, env=env, timeout=60)
    return proc.returncode, proc.stdout.strip()


def payload(cwd, source="startup"):
    data = {"session_id": "init-nudge-test", "hook_event_name": "SessionStart", "cwd": cwd}
    if source is not None:
        data["source"] = source
    return json.dumps(data)


def spoken(out, cwd):
    try:
        hso = json.loads(out)["hookSpecificOutput"]
    except Exception:
        return False
    text = hso.get("additionalContext", "")
    return (hso.get("hookEventName") == "SessionStart"
            and " init " in text
            and os.path.normpath(cwd) in text
            and FAKE_ENTRY in text)


CASES = [
    ("git root without index speaks", payload(GIT_ROOT), FAKE_ENTRY, "speak", GIT_ROOT),
    ("worktree .git file speaks", payload(WORKTREE), FAKE_ENTRY, "speak", WORKTREE),
    (".aidex without index.db speaks", payload(EMPTY_AIDEX), FAKE_ENTRY, "speak", EMPTY_AIDEX),
    ("source clear speaks", payload(GIT_ROOT, "clear"), FAKE_ENTRY, "speak", GIT_ROOT),
    ("missing source speaks", payload(GIT_ROOT, None), FAKE_ENTRY, "speak", GIT_ROOT),
    ("indexed repository is silent", payload(INDEXED), FAKE_ENTRY, "silent", None),
    ("subdirectory of a repository is silent", payload(GIT_SUBDIR), FAKE_ENTRY, "silent", None),
    ("directory outside git is silent", payload(PLAIN), FAKE_ENTRY, "silent", None),
    ("source resume is silent", payload(GIT_ROOT, "resume"), FAKE_ENTRY, "silent", None),
    ("source compact is silent", payload(GIT_ROOT, "compact"), FAKE_ENTRY, "silent", None),
    ("missing CLI entry is silent", payload(GIT_ROOT), MISSING_ENTRY, "silent", None),
    ("nonexistent cwd is silent", payload(os.path.join(BASE, "nope")), FAKE_ENTRY, "silent", None),
    ("payload without cwd is silent", json.dumps({"source": "startup"}), FAKE_ENTRY, "silent", None),
    ("non-dict payload is silent", json.dumps(["startup"]), FAKE_ENTRY, "silent", None),
    ("malformed payload is silent", "{not json", FAKE_ENTRY, "silent", None),
]


def main():
    failures = []
    for name, stdin_text, entry, expected, cwd in CASES:
        code, out = run_hook(stdin_text, entry)
        if code != 0:
            ok = False
        elif expected == "speak":
            ok = spoken(out, cwd)
        else:
            ok = out == ""
        print(f"{'PASS' if ok else 'FAIL'}  {name}")
        if not ok:
            failures.append(f"{name}: exit={code} stdout={out[:200]!r}")

    with open(HOOK, encoding="utf-8") as fh:
        source = fh.read()
    portable = not re.search(r"[A-Za-z]:[\\/]|/Users/|/home/", source)
    print(f"{'PASS' if portable else 'FAIL'}  hook source carries no absolute path")
    if not portable:
        failures.append("hook source carries an absolute path")

    total = len(CASES) + 1
    print(f"\n{total - len(failures)}/{total} passed")
    for failure in failures:
        print("  " + failure)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
