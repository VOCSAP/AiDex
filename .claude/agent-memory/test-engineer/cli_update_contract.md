---
name: cli-update-contract
description: Documented contract of the `update` CLI branch (src/index.ts), covered by tests/cli-update.test.js (spec_99b30fea) and tests/cli-update-summary-contract.test.js (spec_a745959c)
metadata:
  type: project
---

`node build/index.js update <projectPath> <file...> [--verbose] [-- <file...>]` is invoked by a
machine-global git hook on every commit/merge/checkout/rebase across ALL repos on this station.
A defect there is station-wide. tests/cli-update.test.js (spec_99b30fea, commit 18e9201) freezes
its CONTRACT as regression tests, not today's exact control flow, because src/index.ts and
src/db/queries.ts are actively patched by other workers concurrently (see [[node_abi_trap]] for
the interpreter side of this).

**Why:** the operator explicitly asked for contract-level tests (not implementation-detail tests)
because the code under test moves under concurrent editing; a test tied to today's control flow
would go red on every unrelated refactor.

**How to apply:** when extending or re-reading this suite, re-derive the contract from
src/commands/shared.ts (`validateIndex`, `withDatabase`) and src/commands/update.ts
(`update()`/`remove()`) rather than trusting a stale summary — these are exactly the files other
workers touch.

## Non-obvious contract points (measured, not guessed)

- **Missing/never-indexed file arg is a TRUE silent no-op**, not a "skip". `remove()`
  (src/commands/update.ts) returns `{success:true, removed:false, error:'File not found in index'}`
  for a file never indexed. The CLI branch only increments `removed++` when `res.removed` is
  `true` — so a missing file increments NO counter at all. Do not assert `Skipped: N` for this
  case; assert absence from the files table and `Errors: 0` instead.
- **Corrupted `index.db` degrades silently.** `withDatabase()` (src/commands/shared.ts) has no
  try/catch around its own `openDatabase()` call, so an unreadable/corrupt DB throws OUT of
  `update()`/`remove()` uncaught, lands in `index.ts`'s outer per-file catch as `errors++`, and
  produces **zero bytes on stdout AND stderr** in non-verbose mode (no console output anywhere in
  shared.ts). Verified: exit 0, `res.stdout === ''`, `res.stderr === ''`.
- **A file argument that is itself just `-v` (or `--verbose`) with NO extension** is a poor
  fixture for testing the `--` end-of-options guard: `extract()` rejects any extension-less
  filename as "Unsupported file type" regardless of the guard, so it always shows up as
  `Skipped: 1` once it reaches the per-file loop. The observable guard signal is NOT
  updated-vs-skipped, it's **whether the token reaches the loop at all**:
  - without `--`: exact-match option filtering drops the lone `-v` token, `fileArgs` ends up
    EMPTY, which trips the same usage-error guard as calling `update` with zero file args
    (`exit 1`, `stderr` matches `/Usage:/`) — not `exit 0` with `Skipped: 0` as one might expect.
  - with a trailing `--`: the token reaches the loop, `Skipped: 1` (unsupported type), `exit 0`.
- **Pure case-only rename (e.g. `src/Widget.ts` deleted + `src/widget.ts` added in the SAME
  update batch) now collapses to exactly one row** — CONFIRMED FIXED as of commit `d30abf3`
  (win32 `realpathSync.native` case-correction block in src/index.ts). A prior session's
  DÉDUIT prediction that this would leave 2 stale rows was WRONG; corrected by direct
  measurement (test passed first run) and by a deliberate-breakage proof: manually inserting a
  duplicate old-case row into the post-fix DB and confirming the test's own oracle
  (`paths.toHaveLength(1)`) correctly rejects that 2-row state. Do not re-introduce a
  DÉDUIT-only prediction here without re-measuring; the underlying code is actively patched.
- **Sandbox-escape skip (`../`, absolute, cross-drive, UNC) runs BEFORE any `existsSync` call**
  in src/index.ts — confirmed by reading the source (relFile check precedes the file-exists
  branch). Tests for this must NOT create the escaping target on disk; a test that only passes
  because the target happens to exist is not actually proving the guard.
- **`.png` (and other `DEFAULT_EXCLUDE`/media extensions) hits the "excluded by pattern" skip
  path, not "unsupported type"** — both land in `skipped++` in index.ts so the counter alone
  can't distinguish them; the `update()` return `error` string differs
  (`'File is excluded by pattern: ...'` vs `'Unsupported file type or parse error'`) if a test
  ever needs to distinguish.

## Build-state race with concurrent peers (re-confirmed this session)

A transient full-suite failure right after an unrelated refactor is not automatically a
regression from that refactor. Before concluding a change broke something, re-run once or twice:
another peer's in-progress, uncommitted `npm run build` recompiling `src/` into `build/*.js` at
the exact moment of a test run can produce a spurious failure batch that clears on the next run.
Confirm via `git diff --stat -- src/<file>.ts` timestamp correlation with `build/<file>.js`
before attributing the failure to your own change.

## stdout/stderr summary-line contract (spec_a745959c, tests/cli-update-summary-contract.test.js)

`hooks/claude/aidex-queue-drain.py` (a Stop hook) cannot use process exit code to detect a failed
reindex batch, because index.ts forces `process.exitCode = 0` unconditionally by design (see above).
It parses the `--verbose` stdout summary line instead. This is now a locked contract test, not just
a documented fact:

- stdout: exactly one line matching `Done. Updated: N, Removed: N, Skipped: N, Errors: N`, always
  present in `--verbose` mode, `Errors: N` with N > 0 being the hook's sole failure signal.
- stderr: per-file detail `error: <relFile>: <message>` — measured exact text for a corrupted
  `index.db` is `error: <file>: file is not a database` (SQLITE_NOTADB). This message is NOT
  produced by opening the corrupted file itself — `new Database(path)` alone succeeds even against
  a plain-text file. It is produced by `AiDexDatabase`'s constructor calling
  `db.pragma('journal_mode = WAL')` (src/db/database.ts:36), the first WRITE against the file,
  which is where SQLite validates the header and throws.
- stdout NEVER carries the per-file `error:` lines; stderr NEVER carries the summary line.
- Exit code is 0 in both a healthy and a failing batch — this is itself part of the contract the
  hook depends on, not an oversight to fix.
- Simplest failure fixture: overwrite `.aidex/index.db` with a plain text file. `validateIndex()`
  (src/commands/shared.ts:30-33) only checks `existsSync`, so this still passes the "no index"
  no-op gate and reaches the per-file loop, where each file's own `openDatabase()` call throws
  independently (DB is opened per file, not once for the whole batch) — a 2-file batch against a
  corrupted DB produces `Errors: 2`, one stderr line each.
- All 5 assertion helpers in this test proven load-bearing via deliberate breakage (wrong expected
  Errors count, wrong exit code, stdout/stderr swapped, wrong filename queried, summary-line search
  pointed at the wrong stream) — each reverted after confirming red, final file identical to the
  reviewed version (`git diff` clean before commit).

## agent-forge verify in a multi-worker `/tmp/af` environment

With multiple concurrent workers, `/tmp/af/{body,result}.json` is a SHARED, COLLISION-PRONE
scratch path — one worker can read another's `verify-result.json` and believe their own work is
validated by a proof that isn't theirs. Use a dedicated scratch dir per invocation, e.g.
`/tmp/af-test-$$` (or any unique suffix), for `--input`/`--output` on every `agent-forge verify`
call. Also see the global `agent-forge.md` rule (forward-slash Windows paths required for
`verify` steps that spawn an absolute-path binary; `/c/...` MSYS-style paths and backslash-escaped
paths both fail against agent-forge's native Rust spawn).
