---
name: project-query-engine-substring-only
description: AiDex's items query engine (query.ts/queries.ts) does plain substring/prefix/exact match, no tokenization -- multi-word literal search only works for contiguous phrases
metadata:
  type: project
---

AiDex's `query()` (src/commands/query.ts) passes `params.term` unmodified into `queries.countItems`/`searchItems` (src/db/queries.ts). No word-splitting exists anywhere in that path. `itemMatchParam` (queries.ts:496-499) wraps the whole term into a single SQL `LIKE '%term%'` (contains) or `'term%'` (starts_with); exact mode uses `term = ? COLLATE NOCASE`. `escapeLike` (queries.ts:9-11) only escapes `\`, `%`, `_` -- no whitespace normalization.

Measured (throwaway SQLite DB, real SQL from queries.ts, item = "No global index found. Run aidex_global_init first."):
- exact full phrase: match. Case-insensitive: match (COLLATE NOCASE).
- contains contiguous substring: match. starts_with prefix: match.
- contains non-contiguous words ("global first" against a string containing both but not adjacent): 0 match.
- reversed word order: 0 match.
- differing whitespace (double space, tab vs space): 0 match, in BOTH exact and contains modes -- no normalization anywhere.

**Why:** This matters for the roadmap card about lifting the `classifyPattern` whitespace guard in src/coverage/rule.ts (currently rejects any pattern containing whitespace as `not_indexable`, so multi-word literals never enter the `items` table). Lifting that guard alone grows the index but does NOT make multi-word literals usefully searchable for partial/keyword-style queries -- only exact phrase or contiguous substring works. A separate card (10096483, IDF multi-term weighting / tokenization) is a functional prerequisite for keyword-style search over literals, not an independent enhancement.

**How to apply:** Before recommending "just lift the guard" as sufficient, flag that partial/non-contiguous/reordered/differently-spaced queries return zero results even when the literal is indexed. If tokenization lands later, whitespace normalization (space/tab/multi-space) needs to be handled explicitly since none exists today.
