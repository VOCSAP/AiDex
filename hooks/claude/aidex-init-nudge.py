#!/usr/bin/env python3
"""SessionStart hook (matcher "startup|clear"): tell the agent that the git
repository it starts in has no AiDex index, and hand it the CLI command that
builds one.

Speaks only when the session cwd is the root of a git repository (`.git`
present, directory or worktree file), holds no `.aidex/index.db`, and the AiDex
CLI entry point is discoverable. Silent everywhere else; every failure is
silent and exits 0.
"""

import json
import os
import sys

SPOKEN_SOURCES = {"startup", "clear"}


def load_common():
    """Imported only once the cwd qualifies: the import parses the Claude
    config, a cost every non-repository session would pay otherwise."""
    try:
        import aidex_hook_common
    except Exception:
        return None
    return aidex_hook_common


def init_command(common, root):
    entry = common.AIDEX_ENTRY
    if not entry or not os.path.isfile(entry):
        return None
    node = next((n for n in common.NODE_CANDIDATES if n), None)
    if not node:
        return None
    return f'"{node}" "{entry}" init "{root}"'


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    if not isinstance(data, dict):
        return
    source = data.get("source")
    if source is not None and source not in SPOKEN_SOURCES:
        return
    cwd = data.get("cwd")
    if not isinstance(cwd, str) or not os.path.isdir(cwd):
        return
    if not os.path.exists(os.path.join(cwd, ".git")):
        return
    if os.path.isfile(os.path.join(cwd, ".aidex", "index.db")):
        return

    common = load_common()
    if common is None:
        return
    command = init_command(common, os.path.normpath(cwd))
    if command is None:
        return

    message = (
        "This git repository has no AiDex index, so the aidex_* search tools "
        f"cannot answer here. Build it once with Bash: {command}"
    )
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": message,
    }}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
