#!/usr/bin/env python3
"""PostToolUse hook -- queue an edited file for reindexing, cheaply.

Matcher "Edit|Write|MultiEdit" in settings.json. This hook does the minimum
work possible: read the file path Claude Code already handed it on stdin,
check for a local .aidex index with a single stat, and append a line to a
per-session queue file. It NEVER spawns Node -- that cost is paid exactly
once per turn by the paired Stop hook (aidex-queue-drain.py), not once per
edit. See that file for the drain side of this design.

Fails silent and cheap in every branch: a stale index is an inconvenience,
a blocked or slowed-down turn is an outage. Stricter than aidex-grep-nudge.py
(which only fails open on the block decision) -- this hook never blocks
anything at all, so every error path is just "do nothing, exit 0".
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aidex_hook_common import has_index, queue_path  # noqa: E402


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if not isinstance(data, dict):
        # Valid JSON but not an object (null, list, string, number) -- the
        # .get() calls below would raise on anything else. Silence is the
        # contract here, never a traceback on stderr.
        sys.exit(0)

    session_id = data.get("session_id")
    tool_input = data.get("tool_input")
    if not isinstance(tool_input, dict):
        tool_input = {}
    file_path = tool_input.get("file_path")
    cwd = data.get("cwd") or os.getcwd()

    if not session_id or not isinstance(file_path, str) or not file_path:
        sys.exit(0)

    project_dir = cwd
    if not has_index(project_dir):
        # No AiDex index for this session's project -- no queue file, ever.
        sys.exit(0)

    abs_file = file_path if os.path.isabs(file_path) else os.path.join(project_dir, file_path)

    try:
        with open(queue_path(session_id), "a", encoding="utf-8") as fh:
            fh.write(f"{project_dir}\t{abs_file}\n")
    except Exception:
        pass  # an unwritable queue is not a reason to slow down the turn

    sys.exit(0)


if __name__ == "__main__":
    main()
