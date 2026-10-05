# Issue tracker: shared roadmap (claude-peers)

Issues and specs for this repo live in the shared roadmap backlog exposed by the
`claude-peers` MCP server, not in GitHub Issues (disabled on this repository).
The backlog is scoped to this repository and shared across every agent session
working on it, now and later.

## Conventions

- **Create an issue**: `roadmap_add` with `title`, `kind`
  (`feature` | `bug` | `debt` | `idea` | `chore`), `priority` (MoSCoW), and a
  filled `context` field. `context` is the briefing for a future session with
  none of this one's context: objective, scope boundaries, relevant files and
  tests, acceptance criteria, decisions already made.
- **Read an issue**: `roadmap_get <id>`, which accepts a unique id prefix (the
  8-char id shown by `roadmap_list` is enough).
- **List issues**: `roadmap_list` with a filter (`statuses`, `kinds`, `triages`,
  `priorities`, `tags`, `q`). Always pass a filter; never load the whole board.
  Within a filter the terms are OR, between filters they are AND.
- **Comment on an issue**: `roadmap_append_context`. It appends without
  replacing, and it works on another agent's card even while that card is
  locked.
- **Apply a triage role**: `roadmap_update` with `triage`.
- **Close**: `roadmap_update` with `status: done`. `roadmap_archive` is a
  reversible soft delete that hides the card from default lists instead.

## Status vs triage

Two independent axes.

- `status` (`idea` -> `planned` -> `in_progress` -> `done`) is progress.
  `in_progress` LOCKS the card under the calling peer id: set it only when work
  really starts, and set it back to `planned` when stopping before completion.
- `triage` is who the card waits on. See `triage-labels.md`.

`priority: wont` is required before `triage: wontfix` is accepted.

## Pull requests as a request surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external
PRs as feature requests; `/triage` reads this flag.)_

## When a skill says "publish to the issue tracker"

Call `roadmap_add`, with `context` filled.

## When a skill says "fetch the relevant ticket"

Call `roadmap_get <id>`. Do not ask to be handed a copy of the briefing.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single card, **child tickets** are cards
carrying the map's tag.

- **Map**: one card tagged `wayfinder:map`, holding the Notes /
  Decisions-so-far / Fog body in its `description`.
- **Child ticket**: a card tagged with the map's tag plus `wayfinder:<type>`
  (`research` / `prototype` / `grilling` / `task`).
- **Blocking**: the `depends_on` field, holding the ids of blocker cards. A
  ticket is unblocked when every card it depends on is `done`.
- **Frontier query**: `roadmap_list` filtered on the map's tag with
  `statuses: ["idea", "planned"]` and `order: queue`; drop any card whose
  `depends_on` still points at a card that is not `done`; first in queue order
  wins. Ties share a wave.
- **Claim**: `roadmap_update` with `status: in_progress`, the session's first
  write. It takes the lock.
- **Resolve**: `roadmap_append_context` with the answer, then `roadmap_update`
  with `status: done`, then append a pointer to the map's Decisions-so-far.
