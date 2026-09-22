# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those
roles to the actual values used in this repo's issue tracker.

This tracker has no labels: the role is the `triage` field of a roadmap card,
an enum whose values are already the five canonical names. The mapping is the
identity.

| Label in mattpocock/skills | Value in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), set the
card's `triage` field to the corresponding value with `roadmap_update`.

`wontfix` is the one value the tracker constrains: it is refused unless the card
also carries `priority: wont`. Set both in the same call.

Edit the right-hand column to match whatever vocabulary you actually use.
