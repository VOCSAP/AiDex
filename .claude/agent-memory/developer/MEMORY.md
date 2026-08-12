# Developer Memory Index

- [Shared repo swarm](project_shared-repo-swarm.md) — local-patches branch worked by multiple concurrent peer agents; never `git add -A`, watch for foreign commits/diffs mid-task.
- [Hooks probe commands](reference_hooks-probe-commands.md) — exact `python tests/hooks/*.py` commands + expected pass counts (29/12/6/6) for the aidex-grep-nudge hook.
- [agent-forge-spec workflow confirmed](feedback_agent-forge-spec-task-workflow.md) — spec_task -> verify(steps) -> update-spec loop worked first try, no deviation needed.
- [Node PATH/ABI trap](reference_node-path-abi-trap.md) — bare `node` on PATH resolves to v24, use pinned v22.11.0 node.exe for builds/measurements; no `node -e`, write .mjs scripts in-repo not /tmp.
- [Git hooks: global hooksPath + gitleaks trap](reference_git-hooks-global-hookspath.md) — core.hooksPath shadows local .git/hooks machine-wide; templated gitleaks pre-commit panics on RE2.
- [Shared repo swarm](project_shared-repo-swarm.md) — also covers: peers share /tmp scratch, scope agent-forge I/O per-peer; Write-tool vs Bash-tool /tmp visibility mismatch, write agent-forge input via Bash heredoc not Write tool.
- [Write/Edit vs Bash /tmp mount trap](reference_tmp-write-edit-vs-bash-mount-trap.md) — Write/Edit resolves /tmp/... to a drive-relative path, Bash resolves it to the real MSYS mount; use one explicit path or Bash heredocs only.
- [agent-forge verify on Windows: bash.exe + spaces trap](reference_agent-forge-verify-windows-bash.md) — argv `bash <path>` picks WSL's bash.exe not Git Bash; no spaces; use a no-space .cmd wrapper; use `/` not `\\` in JSON paths.
- [agent-forge shared marker race](reference_agent-forge-shared-marker-race.md) — active-marker file is machine-wide not per-session; concurrent peers reset it; re-arm via `help spec-task` before every edit.
- [Multiword literal volume (f08aeeb1)](project_multiword-literal-volume-f08aeeb1.md) — 5-repo measurement: 6.9%-29.9% item growth if whitespace literals indexed; isMixedCase already covers most English sentences as "above".
- [agent-forge JSON body traps](reference_agent-forge-json-body-traps.md) — no `\s+` regex fragments in JSON string values; roadmap append caps 4000/call, 16000/card total, overflow goes via send_message.
- [Rule-version bump on semantics change](feedback_rule-version-bump-on-semantics-change.md) — bump LITERAL_RULE_VERSION proactively whenever classifyPattern/literalQualifies semantics change, even if not asked.
- [Zero-count total-failure heuristic trap](feedback_zero-count-total-failure-heuristic-trap.md) — a "counter===0" failure rule needs a second conjunct ruling out healthy zero-paths (e.g. idempotent re-run); prove with a real repeat-call test, not just synthetic.
- [agent-forge verify: pinned-node PATH doesn't reach `cmd /c` child processes](reference_agent-forge-verify-windows-bash.md) — Bash-tool PATH prefix (POSIX `/c/...`) is invisible to cmd.exe; invoke the pinned node.exe by absolute forward-slash path directly in the step command instead of relying on PATH.
