---
name: claude-code-hook-contract
description: Measured Claude Code 2.1.228 hook payload contract and how to run an isolated hook bench on this station (MultiEdit no longer exists)
metadata:
  type: reference
---

Measured 2026-08-11 on Claude Code **2.1.228**, by capturing raw stdin from a
real session (bench at `D:/AI/_aidex-hookbench`, `bash bench/run-bench.sh`).

**MultiEdit no longer exists as a tool.** A prompt demanding it gets refused:
"The MultiEdit tool doesn't exist in my available tools." Any hook matcher
listing `MultiEdit` has a dead alternative; multi-replacement edits arrive as
several `Edit` calls, or one `Edit` with `replace_all`.

PostToolUse stdin keys: `session_id, transcript_path, cwd, prompt_id,
permission_mode, hook_event_name, tool_name, tool_input, tool_response,
tool_use_id, duration_ms`. `tool_input.file_path` is ABSOLUTE with Windows
separators. Write carries `file_path, content`; Edit carries `file_path,
old_string, new_string, replace_all`.

Stop stdin keys: `session_id, transcript_path, cwd, prompt_id, permission_mode,
hook_event_name, stop_hook_active, last_assistant_message, background_tasks,
session_crons`. No `tool_name`. `CLAUDE_PROJECT_DIR` is exported into the hook
environment.

Cost floor on this station: ~47 ms per hook invocation is bare Python startup;
a Stop that spawns Node and reindexes 3 files costs ~200 ms total.

**Isolating a bench session from the operator's global hooks:** set
`CLAUDE_CONFIG_DIR` to a scratch dir. That dir has no auth, so `claude -p`
answers `Not logged in` until `~/.claude/.credentials.json` is symlinked in
(link, never copy, and remove it afterwards). Also pass
`--strict-mcp-config --mcp-config '{"mcpServers":{}}'` (an empty object is
rejected: the key must be present) and `--permission-mode acceptEdits`.

**Bench trap worth remembering:** `aidex init` on a corrupted `index.db` fails
SILENTLY (SQLITE_NOTADB, and the CLI swallows it), so a "corrupt index" test
poisons every later run in the same fixture. Any harness that corrupts a DB
must `rm -rf .aidex` before re-initialising and abort if the rebuild did not
produce an `index.db`.

The operator's `enforce-agent-forge.sh` blocks Write/Edit on code files unless
`/tmp/agent-forge-state/agent-forge-active` exists, which `agent-forge
--input <json> --output <json> spec-task` creates. That marker is machine-wide,
not per-session. Writing `.md`/`.json`/`.sh` files is always allowed.
