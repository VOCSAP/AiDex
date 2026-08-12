---
name: reference-hooks-probe-commands
description: Exact commands and expected pass counts for the 4 aidex-grep-nudge hook test/probe scripts in tests/hooks/
metadata:
  type: reference
---

The Claude Code nudge hook (`hooks/claude/aidex-grep-nudge.py` since the 2026-08-11 hooks/ reorg, was `hooks/aidex-grep-nudge.py` before) has 4 independent verification scripts under `tests/hooks/`, each runnable standalone with plain `python <path>`:

- `python tests/hooks/aidex-grep-nudge.test.py` — pattern-matching unit tests. Expected: **29/29 green**.
- `python tests/hooks/probe-hook.py` — end-to-end allow/deny decisions against a live oracle. Expected: **12/12 correct**.
- `python tests/hooks/probe-hook-failopen.py` — fail-open guarantees (oracle unreachable, timeout, bad payload, etc. must all `allow`). Expected: **6/6 green**.
- `python tests/hooks/probe-hook-discovery.py` — portability / no-hardcoded-path checks + interpreter discovery. Expected: **6/6 green**.

These 4 files each hardcode the hook's path via `HOOK = os.path.join(REPO_ROOT, "hooks", "claude", "aidex-grep-nudge.py")` — if the hook moves again, all 4 need updating in the same commit, plus `LOCAL-PATCHES.md` section 2's heading which also names the path.

**Why:** a directory reorg (hooks/ split into hooks/claude/ + hooks/git/, 2026-08-11) initially looked risky but these numbers are invariant under a pure move — reran after `git mv` and got identical counts, confirming the move was contract-neutral.

**How to apply:** after any change touching this hook's location or oracle contract, rerun all 4 scripts and diff the pass counts against the numbers above before reporting "green" to a card/reviewer — a partial run or a changed count is the signal something broke.
