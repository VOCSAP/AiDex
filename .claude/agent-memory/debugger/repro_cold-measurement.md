---
name: repro-cold-measurement
description: How to measure AiDex query performance honestly on this machine - Node pinning, cold-process shape, and the traps that faked a gain before
metadata:
  type: project
---

Measure AiDex query cost with **one Node process per call**, not a loop. `withDatabase` (`src/commands/shared.ts`) builds a fresh `Queries` per MCP call and throws it away; any harness that reuses a handle over N iterations measures a warm page cache and a warm statement cache that production never has.

**Why:** that exact harness bias produced a "gain" that survived spec, implementation and review, and cost a full revert (e7a0c8d then 7ca37e2).

**How to apply:**
- Interpreter: `C:/Users/Olivier/AppData/Local/nvm/v22.11.0/node.exe`. The `node` on PATH is v24.x and breaks the `better-sqlite3` ABI (whole test suite fails at once).
- `Queries` takes the DB wrapper, not the raw handle: `new Queries({ getDb: () => db })`.
- Writing raw SQL in a JS template literal: `ESCAPE '\'` gets eaten by the template literal and SQLite answers `ESCAPE expression must be a single character`. Build it as `"ESCAPE '" + String.fromCharCode(92) + "'"`.
- `agent-forge verify` **executes** its `command` field, from a working directory that is not yours: pass absolute Windows paths, and confirm the returned stdout is your own measurement (the shared working directory collides between agents).
- Useful control group: run the same needles in `exact` mode. It isolates the fixed cost (open + prepare + occurrence join) from the LIKE scan.

See [[contains-perf-profile]] for the numbers this produced.
