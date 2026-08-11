#!/usr/bin/env python3
"""Stop hook -- drain the session's edit queue into one Node spawn per project.

Paired with aidex-queue-edit.py (PostToolUse), which appends "<project>\\t
<file>" lines to a per-session queue file without ever spawning a process.
This hook is where that batch is cashed in: read the queue, dedupe it,
group by project (normally exactly one), and invoke
`node build/index.js update <project> <file...>` ONCE per project group --
covering N edited files in 1 process spawn instead of N.

Stop hooks do not get told which files changed (only session_id,
transcript_path, stop_hook_active), which is why the queue file exists at
all: it is the only channel that carries that information here. Parsing the
transcript instead was considered and rejected -- it isn't a contract either
hook can rely on.

Failure posture is stricter than aidex-grep-nudge.py's fail-open block
decision: here NOTHING may block or slow a turn, ever. Every failure -- an
unreadable queue, no interpreter, the CLI missing, a locked SQLite writer,
update() exiting non-zero, a killed process -- exits 0 silently. On a
per-project failure the group's lines are left in the queue untouched, so
the same batch is retried on the next Stop rather than lost or retried
in a blocking loop right now: a stale index is an inconvenience, a blocked
turn is an outage.

A held SQLite writer lock is a measured real case, not theoretical: a
concurrent aidex_init wraps its whole bulk index in one transaction, so it
can hold the writer for tens of seconds. That is exactly why
AIDEX_UPDATE_TIMEOUT_S (see aidex_hook_common.py) is kept short -- a locked
`update` call must fail fast and requeue, not stall this Stop event waiting
out someone else's transaction.
"""

import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aidex_hook_common import (  # noqa: E402
    AIDEX_ENTRY,
    NODE_CANDIDATES,
    UPDATE_TIMEOUT_S,
    queue_path,
)


def read_groups(path):
    """Parse the queue file into {project_dir: [deduped absolute file paths]}.

    Order-preserving dedup within each project group -- not that order
    matters to `update`, but a stable file list makes any future debug log
    reproducible.
    """
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.readlines()
    except Exception:
        return None  # unreadable queue -- caller treats this as "nothing to do"

    groups = {}
    seen = {}
    for line in lines:
        line = line.rstrip("\n")
        if not line or "\t" not in line:
            continue
        project, file_path = line.split("\t", 1)
        if not project or not file_path:
            continue
        seen_set = seen.setdefault(project, set())
        if file_path in seen_set:
            continue
        seen_set.add(file_path)
        groups.setdefault(project, []).append(file_path)
    return groups


def write_groups(path, groups):
    """Rewrite the queue with only the groups still pending. Deletes the
    file entirely once nothing is left, so an empty queue costs one stat
    on the next PostToolUse/Stop rather than growing forever."""
    non_empty = {p: files for p, files in groups.items() if files}
    if not non_empty:
        try:
            os.remove(path)
        except OSError:
            pass
        return
    try:
        with open(path, "w", encoding="utf-8") as fh:
            for project, files in non_empty.items():
                for file_path in files:
                    fh.write(f"{project}\t{file_path}\n")
    except Exception:
        pass  # best effort -- a failed rewrite just means a retry regrows it


def run_update(project_dir, files):
    """Invoke the AiDex CLI update subcommand for one project's batch.
    Returns True on confirmed success (exit code 0), False on anything else
    -- including "could not even start the process", which is not this
    hook's problem to diagnose further."""
    if not AIDEX_ENTRY or not os.path.isfile(AIDEX_ENTRY):
        return False

    for node in NODE_CANDIDATES:
        if not node:
            continue
        try:
            proc = subprocess.run(
                [node, AIDEX_ENTRY, "update", project_dir] + files,
                capture_output=True,
                timeout=UPDATE_TIMEOUT_S,
                text=True,
            )
        except Exception:
            continue  # this interpreter candidate didn't work -- try the next
        return proc.returncode == 0
    return False  # no candidate interpreter could even be launched


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if data.get("stop_hook_active"):
        # This Stop was itself triggered by a hook -- do not re-drain, or a
        # failing update() could loop the Stop event forever.
        sys.exit(0)

    session_id = data.get("session_id")
    if not session_id:
        sys.exit(0)

    path = queue_path(session_id)
    if not os.path.isfile(path):
        sys.exit(0)  # nothing queued this session -- the common case

    groups = read_groups(path)
    if not groups:
        # Unreadable, or every line was malformed/blank -- nothing usable to
        # drain. Leave the file alone rather than guess at cleanup.
        sys.exit(0)

    remaining = {}
    for project_dir, files in groups.items():
        if not files:
            continue
        if run_update(project_dir, files):
            remaining[project_dir] = []  # cleared -- drop from the queue
        else:
            remaining[project_dir] = files  # left for the next Stop

    write_groups(path, remaining)
    sys.exit(0)


if __name__ == "__main__":
    main()
