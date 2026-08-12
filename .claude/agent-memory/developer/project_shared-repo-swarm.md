---
name: project-shared-repo-swarm
description: This repo's local-patches branch is worked concurrently by multiple claude-peers agents dispatched by a team-lead peer via roadmap cards
metadata:
  type: project
---

AiDex (`D:\AI\MCPServer\AiDex`) on branch `local-patches` is being worked by several Claude Code instances at once, coordinated through the claude-peers roadmap (team-lead peer dispatches numbered cards, e.g. "TÂCHE 1/4 du Lot A"). Confirmed 2026-08-11: mid-task, `git status` showed a foreign commit (`b3b8289`, not mine) had landed on top of the branch tip I started from, plus an unrelated uncommitted `src/index.ts` diff (61 lines) that belonged to another agent's in-progress work, not the card I was assigned.

**Why:** delegated cards are scoped narrowly (e.g. one hooks/ reorg), but the working tree is shared live — another peer's commit or uncommitted edit can appear between your `roadmap_get` and your `git commit`.

**How to apply:**
- Before staging, run `git status --short` and diff each file against the card's file list. Only `git add` files the card actually asked for — never `git add -A` / `git add .` on this repo.
- If you see modified/staged content you did not create, do not touch it, do not fold it into your commit, and flag it explicitly in your report back to the team-lead (it may be someone else's unfinished work).
- Expect the branch tip commit hash to differ from what the dispatch message or your initial `git status` snapshot showed — re-check `git log --oneline -5` rather than assuming staleness is a bug.
- See [[feedback-agent-forge-spec-task-workflow]] for the per-card spec_task discipline that runs alongside this.

**Shared /tmp scratch collision (confirmed 2026-08-11, card 1281bf36):** peers on the same machine also share the OS-level temp dir (`/tmp` in Git Bash = `C:\Users\Olivier\AppData\Local\Temp`). Using the skill's conventional path `/tmp/af/{body,verify,...}.json` collided with another peer's concurrent `agent-forge verify` call — my `--input`/`--output` files got silently overwritten mid-flight, and I read back a different peer's jest-test result instead of my own. Fix: use a peer-scoped scratch dir, e.g. `/tmp/af-<your-peer-id>/`, for every `agent-forge --input/--output` file, not the bare `/tmp/af/` from the skill example.

**Write-tool vs Bash-tool /tmp visibility mismatch (observed once, 2026-08-11, unexplained):** used the `Write` tool to create a file under `/tmp/...`, tool reported success, but `cat` of the same path via `Bash` immediately after reported the file did not exist (or showed stale content). Root cause not found. Workaround that reliably worked: write scratch files (especially `agent-forge --input` JSON) via a `Bash` heredoc (`cat > path << 'EOF' ... EOF`), not the `Write` tool — this matches the agent-forge-spec skill's own prescribed method anyway. If a file written via `Write` needs to be read by a process invoked through `Bash`, verify with `Bash cat` before trusting it; don't assume Write/Bash share a view of the same path.
