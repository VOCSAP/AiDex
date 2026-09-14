# Installing the AiDex hooks

`settings.json.template` next to this file is the single reference for
everything AiDex needs in your `settings.json`: ready-to-paste blocks
covering search-time and read-time guidance (`PreToolUse`) and index
maintenance (`PostToolUse`, `Stop`). No installer exists for this fork -- do the steps
below by hand.

## Install steps

1. Copy the hook scripts from this repo into your Claude Code profile:
   ```
   %USERPROFILE%\.claude\hooks\aidex-grep-nudge.py
   %USERPROFILE%\.claude\hooks\aidex-read-nudge.py
   %USERPROFILE%\.claude\hooks\aidex-queue-edit.py
   %USERPROFILE%\.claude\hooks\aidex-queue-drain.py
   %USERPROFILE%\.claude\hooks\aidex_hook_common.py
   ```
   The source for all five is `hooks/claude/` in this repo (moved there from
   the repo root in commit 6c66217 -- do not copy from the old root `hooks/`
   path). `aidex_hook_common.py` is required because `aidex-read-nudge.py`,
   `aidex-queue-edit.py` and `aidex-queue-drain.py` import it;
   `aidex-grep-nudge.py` is standalone.
2. Open your real `%USERPROFILE%\.claude\settings.json` and merge the
   `PreToolUse`, `PostToolUse` and `Stop` entries from
   `settings.json.template` into your existing `hooks` object. Merge, do not
   overwrite -- your settings.json almost certainly already has other
   entries in those same arrays (append to the array, do not replace it).
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

All three hooks are invoked from the **installed profile copy**, not the
repo path:
```
python "$USERPROFILE/.claude/hooks/aidex-grep-nudge.py"
python "$USERPROFILE/.claude/hooks/aidex-queue-edit.py"
python "$USERPROFILE/.claude/hooks/aidex-queue-drain.py"
```
verified directly in this operator's actual `settings.json`. That is the
only thing the three hooks share -- beyond the invocation path convention,
they are two unrelated families that happen to both ship in this template:

- **PreToolUse** (`aidex-grep-nudge.py`, matcher `Grep|Bash`) steers a
  search *before* it runs, toward the AiDex index instead of `Grep`/`Bash`.
- **PostToolUse** + **Stop** (`aidex-queue-edit.py` / `aidex-queue-drain.py`)
  keep the index itself up to date *after* edits land.

Do not read more into the shared invocation path than that convention: the
nudge hook does not touch the reindex queue, and the reindex hooks do not
gate any search.

## What the hooks actually do

- **PreToolUse** (`aidex-grep-nudge.py`) asks the coverage oracle's `aidex
  can` subcommand whether the index already covers what a `Grep`/`Bash`
  call is about to search for. It only blocks the call when the oracle
  answers `covered:true` -- steering the agent to `mcp__aidex__aidex_query`
  instead. Any other verdict, and any oracle failure (timeout, crash,
  unreachable), lets the search through unmodified.
- **PreToolUse** (`aidex-read-nudge.py`, matcher `Read|Bash`) refuses an
  unbounded read of a large file of an indexed project and hands back the
  file's line-ranged plan from the CLI's `outline` subcommand, so the agent
  re-reads with `offset`/`limit`. It only looks at a `Read` without `offset`
  and `limit`, or a Bash command that is a lone `cat <file>` (resolved against
  the session cwd from the payload); `head`, `tail`, `sed -n`, a piped or
  chained `cat`, a `cat` with a display flag (`-A`, `-v`, `-e`, `-t`, `-E`,
  `-T`, `--show-*`) and a payload without `session_id` pass. It refuses only when the file is over the threshold,
  `outline` exits 0, and the file is more than three times the size of the
  plan. Each (session, file) is refused at most once: repeating the same read
  lets it through, recorded in a `<session>.read-nudge.txt` file next to the
  reindex queue.
- **PostToolUse** (`aidex-queue-edit.py`) ONLY appends a
  `<project>\t<file>` line to a per-session queue file in the OS temp dir.
  It never spawns Node and never touches the AiDex CLI.
- **Stop** (`aidex-queue-drain.py`) reads that queue once per turn, groups
  the queued files by project, and spawns the CLI's `update` subcommand
  once per project (chunked at 100 files per spawn, to stay under the
  Windows command-line length limit) -- N edited files reindexed in a
  small number of process spawns instead of N.

Measured costs (reviewer, card `b6760488`, commit `fca6184`): 45-53ms per
edit for the PostToolUse queue append, 190-209ms for the Stop drain of a
typical small batch -- about 0.7% of a 27s turn.

## Failure posture: all three hooks fail open

The reindex pair (`aidex-queue-edit.py`, `aidex-queue-drain.py`) always
exits 0. Every failure branch (unreadable queue, no interpreter found, CLI
missing, a locked SQLite writer, `update()` reporting errors, a killed
subprocess) exits 0 silently. This is deliberate: a stale AiDex index is an
inconvenience, a blocked or slowed-down turn is an outage. A failed
project's files are left in the queue and retried on the next `Stop`
rather than dropped.

`aidex-grep-nudge.py` fails open for a different reason: it only blocks on
an explicit `covered:true` verdict from the coverage oracle, so any oracle
outage or ambiguous answer must let the search proceed -- an unavailable
oracle must never be able to stop an agent from searching at all.

`aidex-read-nudge.py` fails open the same way: any `outline` exit code other
than 0, a timeout, a missing interpreter or entry point, an unreadable payload,
an unwritable state file, or any exception lets the read proceed.

## Environment variables (all optional)

Read by `hooks/claude/aidex_hook_common.py`, shared by the two reindex
hooks and `aidex-read-nudge.py` (`aidex-grep-nudge.py` is standalone and does
not import it), except the two `AIDEX_READ_NUDGE_*` variables, read by
`aidex-read-nudge.py` alone. Node
resolution is automatic (falls back to a pinned nvm path discovered from
the `aidex` MCP server entry in `~/.claude.json` /
`claude_desktop_config.json`), so normally nothing needs to be set.

| Variable | Meaning |
|---|---|
| `AIDEX_NODE` | Overrides the Node executable used to run the AiDex CLI. Falls back to auto-discovery, then a bare `node` on PATH. |
| `AIDEX_ENTRY` | Overrides the path to `build/index.js`. Falls back to the same auto-discovery as `AIDEX_NODE`. |
| `AIDEX_UPDATE_TIMEOUT_S` | Seconds the Stop hook waits for one `update` subprocess (per project, per chunk) before giving up and requeuing. Default `3`. Kept short on purpose: a held SQLite writer lock (e.g. a concurrent `aidex_init`) can stall for several seconds, and the Stop hook must fail fast and retry on the next Stop rather than block the turn. |
| `AIDEX_READ_NUDGE_MIN_BYTES` | Size in bytes a file must exceed before `aidex-read-nudge.py` asks for its plan. Default `5000`; the useful range measured on this station's transcripts is `2000` to `10000`. |
| `AIDEX_READ_NUDGE_TIMEOUT_S` | Seconds `aidex-read-nudge.py` waits for `outline` before letting the read through. Default `1.5` (`outline` answers in 65 to 167 ms). |

There is no `CHUNK_SIZE` environment variable -- the 100-files-per-spawn
chunk size is a hardcoded constant (`CHUNK_SIZE` in
`aidex-queue-drain.py`), not currently configurable at runtime.
