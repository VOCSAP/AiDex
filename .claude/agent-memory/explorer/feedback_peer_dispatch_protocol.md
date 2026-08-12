---
name: feedback-peer-dispatch-protocol
description: When dispatched via claude-peers channel, ACK first by send_message, then deliver final report by send_message too -- terminal output is not delivery
metadata:
  type: feedback
---

Rule: on a claude-peers `<channel>` dispatch, send `ACK <role>` via `send_message` to the dispatching peer_id BEFORE starting work, then send the full structured report via `send_message` again at the end -- even if blocked or the finding contradicts the brief.

**Why:** The dispatching team-lead peer cannot see this session's terminal/stdout. A report only printed locally never reaches them. This was stated explicitly as the delivery contract in a dispatch brief (2026-08-12, AiDex repo, card f08aeeb1/b2d17b5d dispatch from desktop-7b2civn-aidex-3).

**How to apply:** Any time a `<channel source="claude-peers">` message arrives with a role assignment and an "ACK expected" instruction, treat `send_message` calls (ACK + final report) as part of task completion, not optional courtesy. Label every claim MESURÉ/DÉDUIT/SUPPOSÉ in the report per that dispatch's contract when asked.
