# Installing the AiDex reindex hooks

`settings.json.template` next to this file holds two ready-to-paste blocks
(`PostToolUse`, `Stop`) that wire up automatic reindexing after `Edit`/`Write`
calls. No installer exists for this fork -- do the steps below by hand.

## Install steps

1. Copy the hook scripts from this repo into your Claude Code profile:
   ```
   %USERPROFILE%\.claude\hooks\aidex-queue-edit.py
   %USERPROFILE%\.claude\hooks\aidex-queue-drain.py
   %USERPROFILE%\.claude\hooks\aidex_hook_common.py
   ```
   All three are required -- the first two import the third.
2. Open your real `%USERPROFILE%\.claude\settings.json` and merge the
   `PostToolUse` and `Stop` entries from `settings.json.template` into your
   existing `hooks` object. Merge, do not overwrite -- your settings.json
   almost certainly already has other entries in those same arrays (append
   to the array, do not replace it).
3. Restart Claude Code so the new hooks are picked up.

This template does not touch your real `settings.json` -- that step stays
yours.

## Why `Edit|Write`, not `Edit|Write|MultiEdit`

The `MultiEdit` tool no longer exists in Claude Code 2.1.228 (verified on
this operator's own build, 2026-08-11). Multi-file edits now go through
`Edit` with `replace_all`, so `Edit` alone already covers what `MultiEdit`
used to. Including a dead tool name in the matcher is harmless (it would
just never fire), but it is not needed.

## Invocation path convention

Hooks are invoked from the **installed profile copy**, not the repo path --
matching this operator's existing hook, `aidex-grep-nudge.py` (a separate,
unrelated PreToolUse hook that nudges `Grep`/`Bash` calls toward
`mcp__aidex__aidex_query`), which is wired as:
```
python "$USERPROFILE/.claude/hooks/aidex-grep-nudge.py"
```
verified directly in this operator's actual `settings.json` (matcher
`Grep|Bash`, PreToolUse). The two new blocks in this template follow the
same convention. It is shown here only as an invocation-path reference --
it is a distinct, already-installed hook, not part of this template's
PostToolUse/Stop pair, and this file does not modify it.

## What the hooks actually do

- **PostToolUse** (`aidex-queue-edit.py`) ONLY appends a
  `<project>\t<file>` line to a per-session queue file in the OS temp dir.
  It never spawns Node and never touches the AiDex CLI.
- **Stop** (`aidex-queue-drain.py`) reads that queue once per turn, groups
  the queued files by project, and spawns the CLI's `update` subcommand
  once per project (chunked at 100 files per spawn, to stay under the
  Windows command-line length limit) -- N edited files reindexed in a
  small number of process spawns instead of N.

Measured costs (reviewer, card `b6760488`, commit `83ef31b`): 45-53ms per
edit for the PostToolUse queue append, 190-209ms for the Stop drain of a
typical small batch -- about 0.7% of a 27s turn.

## Failure posture: both hooks always exit 0

Every failure branch (unreadable queue, no interpreter found, CLI missing,
a locked SQLite writer, `update()` reporting errors, a killed subprocess)
exits 0 silently. This is deliberate: a stale AiDex index is an
inconvenience, a blocked or slowed-down turn is an outage. A failed
project's files are left in the queue and retried on the next `Stop`
rather than dropped.

## Environment variables (all optional)

Read by `hooks/claude/aidex_hook_common.py`, shared by both hooks. Node
resolution is automatic (falls back to a pinned nvm path discovered from
the `aidex` MCP server entry in `~/.claude.json` /
`claude_desktop_config.json`), so normally nothing needs to be set.

| Variable | Meaning |
|---|---|
| `AIDEX_NODE` | Overrides the Node executable used to run the AiDex CLI. Falls back to auto-discovery, then a bare `node` on PATH. |
| `AIDEX_ENTRY` | Overrides the path to `build/index.js`. Falls back to the same auto-discovery as `AIDEX_NODE`. |
| `AIDEX_UPDATE_TIMEOUT_S` | Seconds the Stop hook waits for one `update` subprocess (per project, per chunk) before giving up and requeuing. Default `3`. Kept short on purpose: a held SQLite writer lock (e.g. a concurrent `aidex_init`) can stall for several seconds, and the Stop hook must fail fast and retry on the next Stop rather than block the turn. |

There is no `CHUNK_SIZE` environment variable -- the 100-files-per-spawn
chunk size is a hardcoded constant (`CHUNK_SIZE` in
`aidex-queue-drain.py`), not currently configurable at runtime.
