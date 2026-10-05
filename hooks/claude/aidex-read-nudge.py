#!/usr/bin/env python3
"""PreToolUse hook (matcher "Read|Bash"): refuse an unbounded read of a large
file of an indexed project and hand back its line-ranged plan from
`aidex outline`, so the agent reads only the range it needs.

Only two shapes are judged: the Read tool without offset and limit, and a Bash
command that is a lone `cat <file>` without a display flag. Everything else,
and every failure, passes: a wrong refusal teaches the model to work around
the tooling, a wrong pass costs one read.
"""

import json
import os
import re
import shlex
import subprocess
import sys


def _env_number(name, default, cast):
    try:
        return cast(os.environ.get(name) or default)
    except ValueError:
        return default


# Above 5000 bytes sit 41 percent of the unbounded Read calls measured on this
# station's transcripts but 82 percent of their bytes. Tunable between 2000
# and 10000 without touching the code.
MIN_BYTES = _env_number("AIDEX_READ_NUDGE_MIN_BYTES", 5000, int)

# `outline` answers in 65 to 167 ms; a spawn that takes longer passes the read.
ORACLE_TIMEOUT_S = _env_number("AIDEX_READ_NUDGE_TIMEOUT_S", 1.5, float)

# A refusal only pays when the plan is much shorter than the file it replaces.
PLAN_RATIO = 3

NO_PLAN_EXIT = 3

MSYS_DRIVE_RE = re.compile(r"^/([A-Za-z])(/.*)?$")
SHELL_METACHARS = set("|;&<>`$()\n")

# These flags make cat print invisible characters: the intent is to inspect
# bytes, which no line-ranged plan replaces.
CAT_DISPLAY_SHORT = set("AvetET")


def load_common():
    """Imported only once a read is worth judging: the import parses the
    Claude config, a cost every Read and Bash call would pay otherwise."""
    try:
        import aidex_hook_common
    except Exception:
        return None
    return aidex_hook_common


def find_index_root(path):
    directory = os.path.dirname(path)
    while True:
        if os.path.isfile(os.path.join(directory, ".aidex", "index.db")):
            return directory
        parent = os.path.dirname(directory)
        if parent == directory:
            return None
        directory = parent


def lone_cat_operand(command):
    """The file of a command that is exactly `cat [flags] <file>`, else None."""
    if not isinstance(command, str) or SHELL_METACHARS & set(command):
        return None
    try:
        tokens = shlex.split(command)
    except ValueError:
        return None
    if not tokens or os.path.basename(tokens[0]) != "cat":
        return None
    operands = []
    options_done = False
    for tok in tokens[1:]:
        if not options_done and tok == "--":
            options_done = True
        elif not options_done and tok.startswith("-") and tok != "-":
            if tok.startswith("--show-") or (not tok.startswith("--") and CAT_DISPLAY_SHORT & set(tok[1:])):
                return None
        else:
            operands.append(tok)
    return operands[0] if len(operands) == 1 and operands[0] != "-" else None


def resolve_operand(operand, cwd):
    """Resolve against the SESSION cwd from the payload, never this process's."""
    path = os.path.expanduser(operand)
    if os.name == "nt":
        match = MSYS_DRIVE_RE.match(path)
        if match:
            path = match.group(1) + ":" + (match.group(2) or "/")
    if not os.path.isabs(path):
        if not cwd:
            return None
        path = os.path.join(cwd, path)
    return os.path.normpath(path)


def ask_outline(common, path, root):
    """The plan on stdout, or None when there is no plan or no answer."""
    if not os.path.isfile(common.AIDEX_ENTRY):
        return None
    for node in common.NODE_CANDIDATES:
        if not node:
            continue
        try:
            proc = subprocess.run(
                [node, common.AIDEX_ENTRY, "outline", path, "--project", root],
                capture_output=True,
                timeout=ORACLE_TIMEOUT_S,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        except subprocess.TimeoutExpired:
            return None
        except Exception:
            continue
        if proc.returncode == 0 and proc.stdout.strip():
            return proc.stdout.strip()
        if proc.returncode == NO_PLAN_EXIT:
            return None
    return None


def state_key(path):
    return os.path.normcase(os.path.realpath(path))


def state_path(common, session_id):
    base, _ = os.path.splitext(common.queue_path(session_id))
    return base + ".read-nudge.txt"


def already_refused(common, session_id, path):
    state = state_path(common, session_id)
    if not os.path.isfile(state):
        return False
    with open(state, encoding="utf-8") as fh:
        return state_key(path) in {line.rstrip("\n") for line in fh}


def record_refusal(common, session_id, path):
    with open(state_path(common, session_id), "a", encoding="utf-8") as fh:
        fh.write(state_key(path) + "\n")


def refusal_text(plan, size, via):
    plan_bytes = len(plan.encode("utf-8"))
    return (
        f"Unbounded {via} of a {size}-byte file refused: the AiDex index holds "
        f"its line-ranged plan ({plan_bytes} bytes), below.\n\n{plan}\n\n"
        f"Read only the range you need: the Read tool with offset=<first line> "
        f"and limit=<last line - first line + 1>. If the whole file is really "
        f"needed, repeat the same call: this refusal fires once per file per "
        f"session."
    )


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    if not isinstance(data, dict):
        return
    tool = data.get("tool_name")
    tool_input = data.get("tool_input") or {}
    if not isinstance(tool_input, dict):
        return

    if tool == "Read":
        if tool_input.get("offset") is not None or tool_input.get("limit") is not None:
            return
        path = tool_input.get("file_path")
        if not isinstance(path, str) or not os.path.isabs(path):
            return
        via = "Read"
    elif tool == "Bash":
        operand = lone_cat_operand(tool_input.get("command"))
        if not operand:
            return
        path = resolve_operand(operand, data.get("cwd"))
        if not path:
            return
        via = "cat"
    else:
        return

    # Without a session the once-per-file promise cannot be kept, and a
    # refusal that is never recorded would repeat forever.
    session_id = data.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        return

    if not os.path.isfile(path):
        return
    size = os.path.getsize(path)
    if size <= MIN_BYTES:
        return
    root = find_index_root(path)
    if not root:
        return

    common = load_common()
    if common is None:
        return
    try:
        if already_refused(common, session_id, path):
            return
    except Exception:
        return
    plan = ask_outline(common, path, root)
    if plan is None:
        return
    if size <= PLAN_RATIO * len(plan.encode("utf-8")):
        return
    # Recorded only once the refusal is certain: a file that had no plan yet
    # must still be refused once it gets one.
    try:
        record_refusal(common, session_id, path)
    except Exception:
        return

    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": refusal_text(plan, size, via),
    }}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
