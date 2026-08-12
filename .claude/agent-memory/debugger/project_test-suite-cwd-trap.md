---
name: test-suite-cwd-trap
description: The jest suite only passes when launched from the repo root - four test files resolve the repo root from process.cwd(), which produces convincing false "the commit broke everything" reports
metadata:
  type: project
---

Before believing any "commit X broke the suite" report here, ask where jest was launched from. Four test files take the repo root from `process.cwd()`, not from their own location:
`tests/cli-update-summary-contract.test.js:55`, `tests/cli-update.test.js:41`, `tests/query-corpus.test.js:66-67`, `tests/coverage-oracle.test.js:87`.

**Why:** on 2026-08-12 this produced a report of "46 failed / 72 passed, 3 suites down" blamed on commit 34532c8. Same commit, same build, same pinned node, launched from the repo root: 138/138 green. Launched from `C:/Users/Olivier`: 3 of the 6 original suites collapse. A run with a non-root cwd reproduced the reported pass count (72) exactly.

**How to apply:** reproduce with the cwd forced, not inherited:
`cmd /c "cd /d D:/AI/MCPServer/AiDex && <node22> --experimental-vm-modules node_modules/jest/bin/jest.js"`.
Tell-tale lines of the cwd defect, not of a code defect:
- `ENOENT: ... open 'C:\Users\Olivier\tests\fixtures\query-corpus.json'`
- `Cannot find module 'C:\Users\Olivier\build\index.js'`
- `expected 2 rows in files table after init(), got 0` (see below - this one looks like a real indexing bug and is not)

Related trap: `agent-forge verify` runs its `command` from an unstable cwd (observed both at the repo root and at the user home across two consecutive calls), so a suite launched through it is exactly the broken-cwd case.

`init()` returns `success: true` with an empty `files` table whenever nothing reaches the insert step - measured: `{"success":true,"filesIndexed":0,"errors":[],"files_rows":0}`. `extract()` runs before any insert and per-file throws are swallowed into `errors[]` (`src/commands/init.ts`, `indexFile` and its calling loop). So an assertion that checks the row count without printing `res.filesIndexed` and `res.errors` throws away the diagnosis init already handed it.

See [[repro-cold-measurement]] for the node pinning and agent-forge quirks that apply to every measurement in this repo.
