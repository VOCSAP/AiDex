---
name: aidex-hook-conventions
description: Constraints and recurring defects for the Claude Code hooks in hooks/claude/ (failure posture, exit-code signalling, Windows arg limit, queue hygiene)
metadata:
  type: project
---

Rules to enforce when reviewing anything under `hooks/claude/`.

**Why:** these hooks run in every Claude Code session on the operator's station
(11 concurrent at the time of writing), on every edit and every turn end. The
worst failure mode is a blocked or noisy turn, so the bar is different from
normal code.

**How to apply:** check each point below before approving a hook change.

1. **Exit code of the AiDex CLI is NOT a result signal.** `src/index.ts` update
   branch forces `process.exitCode = 0` in every case, deliberately. Any hook
   that reads `proc.returncode` to decide success/failure is wrong; per-file
   outcomes only appear in the `Done. Updated: N, ... Errors: N` line under
   `--verbose`.
2. **`json.load(sys.stdin)` in a try is not enough.** Valid JSON that is not an
   object (`null`, `[]`, `"x"`, `42`) makes the following `data.get` raise, which
   prints a traceback and exits 1 — and Claude Code shows stderr to the user on
   a non-zero exit. Require `isinstance(data, dict)` and defensive `str()` on
   any field used as a filename.
3. **Windows command-line limit bites around 350-400 absolute paths**
   (measured: 200 files OK, 400 files -> `[WinError 206]`). Any batch built as
   `[exe] + files` needs chunking, or the batch can never run again.
4. **`except Exception: continue` in an interpreter-candidate loop also catches
   `subprocess.TimeoutExpired`**, so a declared timeout becomes
   timeout x number-of-candidates. Catch the timeout separately.
5. **Queue/state files under `tempfile.gettempdir()` need a TTL and 0600.**
   Nothing in `hooks/claude/` currently purges another session's leftovers, and
   on POSIX `/tmp` is world-readable while the files hold absolute project
   paths.

Interpreter resolution is the one thing that is already right: `AIDEX_NODE`,
then the MCP declaration parsed out of `~/.claude.json` /
`claude_desktop_config.json`, then bare `node`. Never a hard-coded path. On this
station `~/.claude.json` is 51 bytes, so discovery actually resolves from
`%APPDATA%\Claude\claude_desktop_config.json`.
