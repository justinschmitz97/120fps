---
kind: overview
status: approved
---

## Kinds
| kind | path | lifetime |
|---|---|---|
| overview | `specs/overview/` | durable |
| package | `specs/packages/<name>/spec.md` | durable |
| decision | `specs/decisions/NNNN-<slug>.md` | append-only |
| milestone | `specs/milestones/mN-<slug>.md` | transient; archive on merge |

## Rules
- Spec before code. PR body must reference spec.
- ADRs append-only. New direction → new ADR with `supersedes:`.
- Spec `tests:` field lists enforcing test paths.
- Spec ↔ code mismatch = bug.
