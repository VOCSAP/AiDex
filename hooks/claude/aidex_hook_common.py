"""Shared helpers for the AiDex queue-edit / queue-drain hook pair.

Not a hook itself -- imported by aidex-queue-edit.py and aidex-queue-drain.py,
which live next to it in hooks/claude/ (Claude Code invokes each hook script
directly, which puts this directory on sys.path[0], so a plain `import
aidex_hook_common` resolves without any package setup).

Interpreter/entry discovery is copied from aidex-grep-nudge.py rather than
reinvented: two copies of the resolution logic in this directory would be one
chance for them to disagree about which Node runs AiDex on this machine. See
that file's own comment for why the config-declared interpreter matters (ABI
mismatch on a PATH `node` of the wrong major).
"""

import json
import os
import tempfile

CLAUDE_CONFIGS = [
    os.path.join(os.path.expanduser("~"), ".claude.json"),
    os.path.join(os.environ.get("APPDATA") or "", "Claude", "claude_desktop_config.json"),
    os.path.join(os.path.expanduser("~"), "Library", "Application Support",
                 "Claude", "claude_desktop_config.json"),
    os.path.join(os.environ.get("XDG_CONFIG_HOME")
                 or os.path.join(os.path.expanduser("~"), ".config"),
                 "Claude", "claude_desktop_config.json"),
]


def discover_aidex():
    """Find (interpreter, entry point) from the MCP server declaration.

    Returns (None, None) when nothing is found, which makes the caller inert
    rather than wrong. Same logic as aidex-grep-nudge.py's discover_aidex().
    """
    for path in CLAUDE_CONFIGS:
        if not path or not os.path.isfile(path):
            continue
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except Exception:
            continue
        blocks = [data.get("mcpServers") or {}]
        for cfg in (data.get("projects") or {}).values():
            blocks.append((cfg or {}).get("mcpServers") or {})
        for servers in blocks:
            server = servers.get("aidex")
            if not isinstance(server, dict):
                continue
            command = server.get("command")
            args = server.get("args") or []
            if command and args:
                return command, args[0]
    return None, None


_discovered_node, _discovered_entry = discover_aidex()

# AIDEX_NODE wins over discovery; bare "node" is the last resort. Same order
# as aidex-grep-nudge.py, for the same reason: a `node` from the wrong major
# aborts on native-addon load before producing anything useful.
NODE_CANDIDATES = [
    os.environ.get("AIDEX_NODE"),
    _discovered_node,
    "node",
]

AIDEX_ENTRY = os.environ.get("AIDEX_ENTRY") or _discovered_entry or ""

# Kept short on purpose: measured (2026-08-11, reviewer) that a held SQLite
# writer lock makes better-sqlite3's default busy_timeout stall an `update`
# call for ~5.9s on a SINGLE file (init.ts wraps the whole bulk index in one
# transaction, so a concurrent aidex_init can hold the writer far longer than
# that). A Stop hook is on the turn's critical path -- it may NEVER wait out
# a lock. 3s is enough for a normal (unlocked) update of a small batch and
# still short enough that a locked run fails fast, gets left in the queue by
# run_update() returning False, and is retried on the next Stop instead of
# stalling this one. Overridable for testing (e.g. a near-zero value to
# exercise the timeout path).
try:
    UPDATE_TIMEOUT_S = float(os.environ.get("AIDEX_UPDATE_TIMEOUT_S") or 3)
except ValueError:
    UPDATE_TIMEOUT_S = 3


def has_index(search_path):
    """Does this project directory carry a .aidex/index.db right here?

    Deliberately not a parent-walking check: aidex_init indexes the exact
    directory it is given, so a session's cwd either IS the project root or
    it isn't -- there is no "find the nearest ancestor project" semantic to
    honour, and guessing one would risk queuing files against the wrong
    project.
    """
    if os.path.isfile(search_path):
        search_path = os.path.dirname(search_path)
    return os.path.isfile(os.path.join(search_path, ".aidex", "index.db"))


def queue_dir():
    d = os.path.join(tempfile.gettempdir(), "aidex-hook-queue")
    os.makedirs(d, exist_ok=True)
    return d


def queue_path(session_id):
    """Per-session queue file. session_id scoping is what makes concurrent
    Claude Code sessions on the same repo (the live normal case here) safe:
    each session only ever reads/writes its own file."""
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in (session_id or "unknown"))
    return os.path.join(queue_dir(), f"{safe}.txt")
