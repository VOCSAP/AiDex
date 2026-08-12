---
name: zero-count-total-failure-heuristic-trap
description: A "total failure" heuristic based on one raw zero-count metric produces false positives on idempotent/no-op re-runs; require a second counter to also be zero.
metadata:
  type: feedback
---

When a card/spec defines "total failure" as a single counter being zero
(e.g. `filesIndexed === 0` while candidates existed), check whether that
counter is also legitimately zero on a healthy no-op path before
implementing it literally — e.g. an idempotent re-run where everything
short-circuits into a *different* counter (`filesSkipped`) rather than the
one being checked.

**Why:** Caught this before shipping on roadmap card `a7039829`
(AiDex `init()` success-mode contract, 2026-08-12): the card's literal
'empty' mode condition (`filesIndexed === 0 && candidates found`) would
have flagged the single most common re-run shape (re-running `init()` on
an unchanged project) as a total failure, even though nothing was actually
wrong — every file just hash-diffed into `filesSkipped` instead of
`filesIndexed`. Fixed by requiring `filesSkipped === 0` too:
`filesFound > 0 && filesIndexed === 0 && filesSkipped === 0`. Proved with
a real "call `init()` twice on the same unchanged project" integration
test, not just a synthetic unit-test case — the synthetic case alone
wouldn't have proven the refinement was *necessary*, only that it was
*consistent*.

**How to apply:** Before implementing any "X is a failure because a
counter hit zero" rule, ask: is there a legitimate/healthy code path where
that exact counter is zero for an unrelated reason? If yes, the check
needs an additional conjunct ruling out the healthy path, and that
refinement should be flagged explicitly to whoever wrote the literal spec
— it changes *when* the rule trips even if it doesn't change what the
rule is trying to catch. See also [[project_multiword-literal-volume-f08aeeb1]]
for another case of a spec's literal wording needing empirical refinement
before shipping.
