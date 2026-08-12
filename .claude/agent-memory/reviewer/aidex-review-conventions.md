---
name: aidex-review-conventions
description: Recurring defect patterns and verification levers when reviewing AiDex code (DB open outside try, path normalization, CLI exit codes, SQLite contention)
metadata:
  type: project
---

Recurring anti-patterns to check first in any AiDex review.

**Why:** Each one was found by measurement on this repo, not by reading; each
reappears wherever a new command wraps `commands/*.ts`.

**How to apply:** run the check named below before writing the report.

1. **DB open sits OUTSIDE the try.** `withDatabase` (`src/commands/shared.ts`)
   calls `openDatabase()` before its `try`; `update()`/`remove()` put their
   try/catch *inside* the callback. So SQLITE_NOTADB, a broken native addon, or
   a failing `journal_mode = WAL` pragma escapes the command and reaches
   `main().catch` in `src/index.ts`, which does `process.exit(1)`. Any new
   caller that loops over files must wrap the call itself.
2. **No `busy_timeout` is set anywhere in `src/`** — better-sqlite3's 5000 ms
   default applies. `init.ts` wraps the whole bulk index in ONE transaction, so
   a concurrent writer stalls ~5 s *per file* and then silently drops it.
   Beware: SQLITE_BUSY does NOT surface as a throw to callers of
   `update()`/`remove()` — those catch internally and return it in
   `res.error`. Any "abort on lock" logic placed in a caller's `catch` is dead
   code; it belongs on the returned-error branch.
3. **Path normalization is done ad hoc at each call site.** `path.relative` +
   `join` round-trips let `../` escape the project root, break across Windows
   drives/UNC (test passes on one path, indexing uses another), and let a
   case-variant create a duplicate `files` row on a case-insensitive FS.
   Look for a guard on `relFile.startsWith('../') || path.isAbsolute(relFile)`.
   `files.path` is `TEXT NOT NULL UNIQUE` with NO `COLLATE NOCASE`
   (`src/db/schema.sql:14`), so nothing dedups casing at the DB level. A
   `realpathSync.native` normalization fixes case *variants* but not a pure-case
   *rename*: on a case-insensitive FS the delete notification still passes
   `existsSync`, so the stale row survives until a full `init`.
4. **Any per-instance cache on `Queries` is dead weight in the MCP path.**
   `withDatabase` (`src/commands/shared.ts`) does `createQueries(db)` then
   `db.close()` in a `finally`, so every MCP tool call gets a COLD `Queries`
   and throws it away. A lazily-built in-memory structure therefore pays its
   full build cost on every single call and never amortizes. Corollary for
   benchmarks: a test that creates one `Queries` in `beforeAll` and loops
   inside a single `test()` measures a warm-cache shape production never has —
   always re-time with a fresh `Queries` per iteration before believing a
   speed-up. (Measured 2026-08-11 on the trigram prefilter: 0.4 ms warm vs
   35 ms cold, against a 2.1 ms full LIKE scan.)
5. **`items` is mutated outside `Queries`.** `src/db/database.ts` does
   `db.getDb().exec('DELETE FROM items')` directly in `createDatabase`. Any
   invalidation hook hung on `Queries.insertItem`/`deleteUnusedItems` misses
   that path, and misses every write from a second connection/process (WAL
   allows concurrent readers with independent JS-side caches). A stale
   derived cache here makes rows silently DISAPPEAR from search results.
6. **`items` is also READ outside `Queries`.** Four call sites build a
   LIKE/equality on `items.term`: `db/queries.ts` (countItems/searchItems),
   `commands/global/global-query.ts` `buildItemSearch` (raw SQL, its own
   param + its own `getCacheKey`), and `embeddings/search.ts` (raw SQL, but
   tokenizes first). Any new normalization/canonicalization of the term added
   in `Queries` must be replicated in `global-query.ts` or `aidex_global_query`
   silently returns fewer rows than `aidex_query` on the SAME index. Measured
   2026-08-12 on the whitespace-normalization commit: mono-project 6/6 hits on
   spacing variants, global 1/4.
7. **Git ignores post-hook exit codes** (measured: post-commit, post-checkout,
   post-merge all leave the git command at exit 0). Claude Code hooks do NOT —
   non-zero surfaces stderr to the user. Judge CLI exit codes against the right
   consumer.

8. **`classifyPattern`'s `hasSeparator`/`isMixedCase` heuristic was written for
   identifiers and over-triggers on prose.** Any English sentence starting with
   a capital, or holding a `.`/`-`/`:`/`_`/`/`, classifies `above` and is
   therefore indexed in EVERY syntactic position, skipping the type/JSX/
   object_value restriction that only `below` (all-lowercase, unpunctuated)
   obeys. Do not read "the positional rule is unchanged" as "phrases are
   bounded by it". Measured 2026-08-12: `"Failed to load config"` -> above,
   `"hello world"` -> below; 166 multi-word items out of 47372 on this repo's
   own `src/`.

Verification levers that work here: pinned Node is
`/c/Users/Olivier/AppData/Local/nvm/v22.11.0/node.exe` (the `node` on PATH
fails with `ERR_DLOPEN_FAILED` on better-sqlite3); `sqlite3` CLI is available
for inspecting `.aidex/index.db` and for holding a `BEGIN EXCLUSIVE` lock to
test contention. Build fresh-ness is checkable with
`grep -c "<branch guard>" build/index.js`.
