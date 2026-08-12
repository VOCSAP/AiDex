---
name: feedback-agent-forge-spec-task-workflow
description: Confirmed working spec_task -> implement -> verify -> update-spec loop for AiDex hooks work, via the agent-forge-spec skill
metadata:
  type: feedback
---

The `agent-forge-spec` skill's documented flow worked end-to-end without any retry on this repo (2026-08-11, hooks/ reorg task): `agent-forge help spec-task` for schema discovery, body written to `/tmp/af/body.json`, `agent-forge --input ... --output ... spec-task` returned `success:true` on the first attempt, then `verify` with a `steps:` array (4 probe commands) and `update-spec status=completed` closed cleanly.

**Why:** confirms the skill's "always discover schema first, never invent body from memory" rule and its enum/cardinality checklist (task_type enum, >=2 acceptance_criteria, >=3 edge_cases, interface_contract as free prose not JSON) are sufficient to avoid the iterate-on-error loop the skill warns about.

**How to apply:** keep using this skill as the default path for any AiDex repo task requiring spec_task before code — no deviation needed. `verify`'s `steps:` array (not `command`) is required for multi-command checks since there's no shell/pipe support — confirmed necessary here since the task needed 4 separate probe scripts checked independently.

**Update (2026-08-11, CLI update subcommand task):** `verify` step `"npm run build"` fails with `{"success":false,"message":"I/O error: program not found"}` on this Windows box — matches the documented `rules/agent-forge.md` npm-shim issue, but `cmd /c npm ...` was not tried here; instead used the pinned Node 22.11.0 binary directly against the TS compiler: `"C:/Users/Olivier/AppData/Local/nvm/v22.11.0/node.exe node_modules/typescript/bin/tsc --noEmit"`. Passed, 2061ms. Also: JSON body written via heredoc must use forward slashes for the Windows node.exe path — a literal backslash path (`C:\Users\...`) breaks JSON parsing (`invalid escape`), since it's not a raw string.
