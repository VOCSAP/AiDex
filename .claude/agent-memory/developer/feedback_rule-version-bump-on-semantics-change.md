---
name: rule-version-bump-on-semantics-change
description: When changing what counts as indexable/covered in src/coverage/rule.ts, bump LITERAL_RULE_VERSION even if not explicitly instructed — it's the stale-index safety mechanism.
metadata:
  type: feedback
---

Implementing f08aeeb1 (lift the whitespace guard so multi-word literals become indexable), the dispatch brief did not explicitly say "bump LITERAL_RULE_VERSION" — but I did it anyway, reasoning from the module's own design intent, and it was accepted without correction.

**Why:** `readCoverage()` in `src/coverage/rule.ts` compares a stored `metadata.literal_coverage.ruleVersion` against the current `LITERAL_RULE_VERSION` constant to report `ruleOutdated`. If the constant isn't bumped when the classification rule's *semantics* change (not just its implementation), an index built under the old rule keeps claiming `covered: true` even though it structurally cannot prove absence of literals the new rule now qualifies — silently wrong answers instead of a safe refusal. The whole point of the coverage oracle is to never claim `covered: true` on a stale index.

**How to apply:** Any edit to `classifyPattern`/`literalQualifies`/the shape or position rules in `src/coverage/rule.ts` that changes which literals qualify (not just refactors the code) should bump `LITERAL_RULE_VERSION`, with a comment explaining why. This is a value-add inference from reading the module, safe to make proactively without being told — same reasoning applies to any future rule.ts semantics change (e.g. if 10096483's IDF/partial-keyword work ever changes what "covered" means for multi-term queries).
