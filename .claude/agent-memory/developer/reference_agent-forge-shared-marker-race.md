---
name: agent-forge-shared-marker-race
description: enforce-agent-forge's active marker is machine-wide, not session-scoped -- concurrent peers reset each other's re-arm
metadata:
  type: reference
---

`enforce-agent-forge.sh`'s PreToolUse gate reads `${AGENT_FORGE_STATE_DIR:-/tmp/agent-forge-state}/agent-forge-active`. That path is a single file on the whole machine, not scoped per Claude Code session or per peer_id. `track-agent-forge.sh` sets it to e.g. `"spec_task"` on any Bash command matching `agent-forge\s+.*\bspec-task\b` -- and this regex also matches the cheap re-arm trick `agent-forge help spec-task`.

**Consequence in a multi-peer swarm** (see [[project_shared-repo-swarm]]): a concurrent peer's own agent-forge activity on the SAME machine (e.g. their `log-outcome` call, which does `rm -f "$FORGE_STATE"`) can reset the marker between two of YOUR successful edits, even though your own spec is still open. Confirmed by reading `enforce-agent-forge.log`: interleaved entries from another peer's tool calls sat between my successful `Edit` and a `BLOCKED: no agent-forge state` on the very next one.

**Workaround, confirmed working over a full multi-edit implementation session:** run `agent-forge help spec-task >/dev/null 2>&1` immediately before EACH subsequent `Edit`/`Write` to a code file, not just once at the start. This re-arms the marker right before the gate check, minimizing the race window. Cheap (help is read-only, no DB write) and safe to spam.

This extends [[agent-forge-spec-task-workflow]] and the `help spec-task` re-arm lesson already in the global `agent-forge.md` rule -- the global rule documents the single-agent re-arm mechanism; this note is the additional fact that the marker is also subject to CROSS-PEER collision on shared machines, which the global rule does not cover.
