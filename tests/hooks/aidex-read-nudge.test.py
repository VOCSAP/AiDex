"""aidex-read-nudge.py end to end: real payloads on stdin, the real `outline`
oracle, on a throwaway project indexed by the CLI.

Every hook process runs with the INDEXED fixture as its own cwd, so a hook that
resolved a relative `cat` operand against its process cwd instead of the
payload's cwd is caught by the non-indexed-cwd case.

Fixture directories are left in the OS temp dir; per-session state files there
fall under the hook queue's own stale-file purge.
"""
import json
import os
import subprocess
import sys
import tempfile
import uuid

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HOOK_DIR = os.path.join(REPO_ROOT, "hooks", "claude")
HOOK = os.path.join(HOOK_DIR, "aidex-read-nudge.py")
sys.path.insert(0, HOOK_DIR)
import aidex_hook_common as common  # noqa: E402


def filler(tag, count):
    return "\n".join(f"    // {tag} filler line {i:03d} keeps this body long" for i in range(count))


def functions(prefix, count, body_lines):
    return "".join(
        f"export function {prefix}{k}(input: number): number {{\n"
        f"{filler(prefix + str(k), body_lines)}\n"
        f"    return input + {k};\n}}\n\n"
        for k in range(count)
    )


BIG = functions("step", 4, 60)
SMALL = functions("tiny", 2, 32)
DENSE = "".join(f"export function f{i:03d}(): number {{ return {i}; }}\n" for i in range(140))
DOC = "# Guide\n\n" + "".join(
    f"## Part {k}\n\n" + ("This paragraph is prose padding for the outline fixture. " * 40) + "\n\n"
    for k in range(4)
)

assert len(BIG) > 10000, len(BIG)
assert 2000 < len(SMALL) < 5000, len(SMALL)
assert 5000 < len(DENSE) < 10000, len(DENSE)
assert len(DOC) > 8000, len(DOC)


def write(root, name, content):
    with open(os.path.join(root, name), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(content)


def index_project(root):
    entry = common.AIDEX_ENTRY
    for node in common.NODE_CANDIDATES:
        if not node or not os.path.isfile(entry):
            continue
        try:
            proc = subprocess.run([node, entry, "init", root], capture_output=True,
                                  text=True, timeout=180)
        except Exception:
            continue
        if proc.returncode == 0 and os.path.isfile(os.path.join(root, ".aidex", "index.db")):
            return True
    return False


def reindex(root, name):
    entry = common.AIDEX_ENTRY
    for node in common.NODE_CANDIDATES:
        if not node or not os.path.isfile(entry):
            continue
        try:
            proc = subprocess.run([node, entry, "update", root, name], capture_output=True,
                                  text=True, timeout=180)
        except Exception:
            continue
        if proc.returncode == 0:
            return True
    return False


def outline_exit(root, path):
    entry = common.AIDEX_ENTRY
    for node in common.NODE_CANDIDATES:
        if not node or not os.path.isfile(entry):
            continue
        try:
            proc = subprocess.run([node, entry, "outline", path, "--project", root], capture_output=True,
                                  text=True, timeout=60)
        except Exception:
            continue
        if proc.returncode in (0, 3):
            return proc.returncode
    return None


def sid():
    return "readnudge-test-" + uuid.uuid4().hex


def run_hook(project, payload, extra_env=None):
    env = dict(os.environ)
    env.update(extra_env or {})
    proc = subprocess.run([sys.executable, HOOK], input=json.dumps(payload),
                          capture_output=True, text=True, cwd=project, env=env, timeout=60)
    out = proc.stdout.strip()
    if proc.returncode != 0:
        return f"EXIT {proc.returncode}", proc.stderr.strip()[:200]
    if not out:
        return "allow", ""
    try:
        hso = json.loads(out)["hookSpecificOutput"]
        return hso["permissionDecision"], hso.get("permissionDecisionReason", "")
    except Exception:
        return "UNPARSEABLE", out[:200]


def read_payload(path, session, cwd, **bounds):
    tool_input = {"file_path": path}
    tool_input.update(bounds)
    return {"tool_name": "Read", "session_id": session, "cwd": cwd, "tool_input": tool_input}


def bash_payload(command, session, cwd):
    return {"tool_name": "Bash", "session_id": session, "cwd": cwd, "tool_input": {"command": command}}


def msys_form(path):
    drive, rest = os.path.splitdrive(path)
    return "/" + drive[0].lower() + rest.replace("\\", "/")


def main():
    project = tempfile.mkdtemp(prefix="aidex-read-nudge-")
    elsewhere = tempfile.mkdtemp(prefix="aidex-read-nudge-noindex-")
    failures = 0
    total = 0

    def check(label, actual, expected, detail=""):
        nonlocal failures, total
        total += 1
        ok = actual == expected
        failures += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'} {label:58} -> {actual} (expected {expected})"
              + (f"\n     {detail}" if detail and not ok else ""))

    write(project, "big.ts", BIG)
    write(project, "small.ts", SMALL)
    write(project, "dense.ts", DENSE)
    write(project, "doc.md", DOC)
    if not index_project(project):
        print("FAIL fixture: `init` through the discovered node/entry did not produce an index")
        return 1
    write(project, "late.ts", BIG)
    write(project, "late2.ts", BIG)
    write(elsewhere, "big.ts", BIG)

    big = os.path.join(project, "big.ts")

    decision, reason = run_hook(project, read_payload(big, sid(), project))
    check("Read, large indexed file, no bounds", decision, "deny", reason)
    check("refusal carries the plan header", "big.ts: " in reason and "step3" in reason, True, reason[:200])
    check("refusal points to offset/limit", "offset=" in reason and "limit=" in reason, True, reason[:200])

    check("Read with limit", run_hook(project, read_payload(big, sid(), project, limit=40))[0], "allow")
    check("Read with offset", run_hook(project, read_payload(big, sid(), project, offset=10))[0], "allow")
    check("Read, file under the default threshold",
          run_hook(project, read_payload(os.path.join(project, "small.ts"), sid(), project))[0], "allow")
    check("Read, same file with threshold lowered to 2000 bytes",
          run_hook(project, read_payload(os.path.join(project, "small.ts"), sid(), project),
                   {"AIDEX_READ_NUDGE_MIN_BYTES": "2000"})[0], "deny")
    check("Read, plan longer than a third of the file",
          run_hook(project, read_payload(os.path.join(project, "dense.ts"), sid(), project))[0], "allow")
    check("Read, file not in the index (oracle exit 3)",
          run_hook(project, read_payload(os.path.join(project, "late.ts"), sid(), project))[0], "allow")
    check("Read, large markdown file",
          run_hook(project, read_payload(os.path.join(project, "doc.md"), sid(), project))[0], "deny")
    check("Read, large file outside any indexed project",
          run_hook(project, read_payload(os.path.join(elsewhere, "big.ts"), sid(), project))[0], "allow")

    session = sid()
    check("repeat: first attempt", run_hook(project, read_payload(big, session, project))[0], "deny")
    check("repeat: second attempt, same session", run_hook(project, read_payload(big, session, project))[0], "allow")
    check("repeat: other session", run_hook(project, read_payload(big, sid(), project))[0], "deny")

    session = sid()
    late2 = os.path.join(project, "late2.ts")
    check("no plan yet: file not in the index", run_hook(project, read_payload(late2, session, project))[0], "allow")
    reindex(project, "late2.ts")
    check("fixture: outline has a plan for late2.ts after update", outline_exit(project, late2), 0)
    check("same session, file now indexed: refused", run_hook(project, read_payload(late2, session, project))[0],
          "deny")

    no_session = read_payload(big, sid(), project)
    del no_session["session_id"]
    check("payload without session_id", run_hook(project, no_session)[0], "allow")

    check("cat relative, payload cwd is the indexed project",
          run_hook(project, bash_payload("cat big.ts", sid(), project))[0], "deny")
    check("cat relative, payload cwd is NOT indexed",
          run_hook(project, bash_payload("cat big.ts", sid(), elsewhere))[0], "allow")
    check("cat absolute, file outside any indexed project",
          run_hook(project, bash_payload(f'cat "{os.path.join(elsewhere, "big.ts")}"', sid(), project))[0],
          "allow")
    if os.name == "nt":
        check("cat with a Git Bash drive path",
              run_hook(project, bash_payload(f'cat "{msys_form(big)}"', sid(), elsewhere))[0], "deny")
    check("head -n on the large file", run_hook(project, bash_payload("head -n 50 big.ts", sid(), project))[0], "allow")
    check("sed -n on the large file", run_hook(project, bash_payload("sed -n 1,40p big.ts", sid(), project))[0], "allow")
    check("cat piped into head", run_hook(project, bash_payload("cat big.ts | head -20", sid(), project))[0], "allow")
    check("tail -n on the large file", run_hook(project, bash_payload("tail -n 20 big.ts", sid(), project))[0], "allow")
    check("cat chained with &&", run_hook(project, bash_payload("cat big.ts && echo done", sid(), project))[0], "allow")
    check("cat -A (show control characters)", run_hook(project, bash_payload("cat -A big.ts", sid(), project))[0], "allow")
    check("cat -v", run_hook(project, bash_payload("cat -v big.ts", sid(), project))[0], "allow")
    check("cat --show-ends", run_hook(project, bash_payload("cat --show-ends big.ts", sid(), project))[0], "allow")

    check("fail open: entry missing",
          run_hook(project, read_payload(big, sid(), project), {"AIDEX_ENTRY": "missing-entry.js"})[0], "allow")
    check("fail open: near-zero oracle timeout",
          run_hook(project, read_payload(big, sid(), project), {"AIDEX_READ_NUDGE_TIMEOUT_S": "0.0001"})[0],
          "allow")
    bad = subprocess.run([sys.executable, HOOK], input="{not json", capture_output=True, text=True, cwd=project)
    check("fail open: unreadable payload", (bad.returncode, bad.stdout.strip()), (0, ""))
    for raw in ('[]', '{"tool_name": "Read", "tool_input": "x"}'):
        odd = subprocess.run([sys.executable, HOOK], input=raw, capture_output=True, text=True, cwd=project)
        check(f"fail open: payload {raw}", (odd.returncode, odd.stdout.strip()), (0, ""))

    print(f"\n{total - failures}/{total} green")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
