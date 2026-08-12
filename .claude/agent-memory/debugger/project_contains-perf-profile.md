---
name: contains-perf-profile
description: Root cause of the "factor 10" contains-scan contradiction (unit mismatch) and the cold profile of aidex_query contains, mono-project and multi-project
metadata:
  type: project
---

The factor-10 contradiction on the `contains` full scan (graphify-8 19-29 ms vs Kleos 2.1 ms, roadmap card b2d17b5d) is a **unit mismatch**, not an index difference: 19-29 ms was a 20-repetition aggregate, 2.1 ms a single cold call.

**Why:** the reverted trigram attempt (e7a0c8d / 7ca37e2) reported its numbers in two different units in two different documents, and nobody normalised them before writing "never explained" into LOCAL-PATCHES.md section 14.

**How to apply:** before treating any AiDex perf figure as comparable, check whether it is per-call or a loop aggregate. Measured facts to reuse:
- The two indexes are equivalent: `items` table 565 KB / 22816 rows (graphify-8) vs 577 KB / 25136 rows (Kleos). A LIKE scan cost cannot differ 10x between them.
- Cold single call (one Node process per call, fresh better-sqlite3 handle): 1.45-1.90 ms graphify-8, 1.57-1.98 ms Kleos.
- 20-rep warm loop: 17.8-24.9 ms graphify-8, 19.5-26.0 ms Kleos — same band.

**Cold profile of the real MCP path** (mono-project, `query()` via `withDatabase`): open DB 2.3-2.6 ms, `countItems` 2.2-4.9 ms, `searchItems` 1.0-1.9 ms, `getOccurrencesByItems` 0.04-17.8 ms. Total 10-55 ms, driven by occurrence fanout, not by the scan. `searchItems` is 5-12% of the call.

**Multi-project** (`global-query.ts`, 14 attached DBs): statement `prepare` ~19 ms, LIKE scan 6.5-8.6 ms, occurrences x lines x files join 0-137 ms. The LIKE scan is ~5% there too.

Note: `query()` runs `countItems` AND `searchItems`, i.e. the items table is scanned twice per call, and `countItems` is the *more* expensive of the two because the `kinds` default (`symbol`) turns on the `EXISTS` sub-select over `occurrences`. See [[repro-cold-measurement]].
