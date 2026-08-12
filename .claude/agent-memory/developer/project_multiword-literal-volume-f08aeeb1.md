---
name: multiword-literal-volume-f08aeeb1
description: measured volume/signal impact of indexing whitespace-containing literals (card f08aeeb1), across 5 real repos
metadata:
  type: project
---

Roadmap card `f08aeeb1` (prerequisite to the split-off `10096483` IDF card) mandated a read-only volume measurement BEFORE any code: how much would `items` grow if `classifyPattern`'s `/\s/.test(p)` gate in `src/coverage/rule.ts` were lifted for multi-word literals. Measured 2026-08-11 via a disposable `.mjs` script (deleted after use, never touched `src/`) that reused `build/parser/tree-sitter.js` (`detectLanguage`/`parseFile`) + `build/parser/languages/index.js` (`getLanguageConfig`), and DUPLICATED (not imported) `literalText`/`literalPosition` from `src/parser/extractor.ts` plus `classifyPattern`'s gates from `src/coverage/rule.ts` with `LITERAL_SHAPE` widened to admit the space char — the only deviation from the real rule.

**Result across 5 repos** (additional items as % of that repo's current `items` count): AiDex 29.9%, graphify-8 (Python) 6.9%, koryphaios (TS-heavy) 11.2%, Kleos (Rust-heavy) 11.6%, Argus (Python+TS+Go+Rust) 17.1%. Per-language dispersion is wider still: Python alone ranged 0.1% (Kleos, tiny Python surface) to 25.3% (AiDex).

**Key non-obvious finding**: `isMixedCase` in `classifyPattern` (`/[a-z]/.test(p) && /[A-Z]/.test(p)`) is NOT position-specific — any ordinary capitalized-first-word English sentence ("Network request failed") trips it, so it lands in `literalRule: 'above'` (indexed unconditionally) almost by default. The strict/`below`-vs-`above` design choice therefore barely affects normal English error/log messages; it only matters for all-lowercase, no-punctuation multi-word phrases ("hello world", "not found", "use strict"). Quantified: unconditionally treating every below-classified multiword literal as `above` (i.e. dropping the position restriction) would add a FURTHER 31%-86% on top of the already-counted totals, worst case on Kleos (86%) because of a Rust code-gen-looking cluster of trailing-space keyword tokens (`"pub "`, `"async "`, `"fn "`, `"struct "`, `"enum "`) that are noise, not searchable strings — a concrete signal-vs-noise counterexample worth flagging to whoever picks the card back up.

See [[project_shared-repo-swarm]] for the disposable-script convention this reused, and `docs/reference/graphify-8` item-count (22816, confirmed prior sub-task) as one of the 5 measured repos.
