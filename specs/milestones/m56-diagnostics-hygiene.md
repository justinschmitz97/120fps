---
kind: milestone
status: implemented
tests:
  - test/unit/m56-diagnostics-hygiene.test.ts
---

# M56 — diagnostics & hygiene

## Purpose

Four small frictions, each the odd one out in an otherwise disciplined
codebase. `"Failed to start Vite dev server"` (src/harness.ts:777) is the one
error in that file that names no cause and no next step. The
`--react-compiler`-requested-but-unresolved error (src/harness.ts:312) omits
the fix its auto-detect sibling states (src/harness.ts:223-227). When the
context-retry budget is exhausted, the environment-vs-component distinction
lives only in a code comment (src/measure.ts:641-644), not in the user-facing
failure. Harness temp directories (`120fps-ctx-*`, `120fps-memo-*`)
accumulate unbounded in the OS temp dir — 30 observed spanning ~3.4 days — a
slow disk leak on any machine that runs the tool repeatedly, CI runners
especially. And `npm test` runs the documented-flaky e2e suite by default
while CI itself runs unit-only, with no `test:unit` script matching what
CLAUDE.md instructs.

## Contract

- The Vite dev-server startup failure MUST include the underlying error's
  message and the harness directory path.
- The `--react-compiler` requested-but-unresolved error MUST name the fix:
  install `babel-plugin-react-compiler` in the project, or drop the flag.
- When the context-retry budget is exhausted, the failure text MUST state that
  repeated dev-server reloads (environment), not the component, are the likely
  cause — promoting the existing code comment to user-facing text.
- Temp hygiene: at session start, harness temp directories matching this
  tool's own prefixes (`120fps-ctx-*`, `120fps-memo-*`) older than 24h MUST
  be removed opportunistically. The sweep MUST be best-effort (all errors
  swallowed), MUST NOT touch anything younger than 24h (concurrent runs are
  always younger), MUST NOT follow paths outside the OS temp dir, and MUST
  NOT block or fail startup.
- package.json MUST provide `test:unit` (unit suite only) and `test:e2e`
  scripts; `test` MUST run the unit suite — matching what repo CI enforces —
  with `test:all` retaining the full run. CLAUDE.md's test commands keep
  working unchanged.
- MUST NOT: delete any temp path not created by this tool's own prefix
  convention, change measurement behavior, or alter any exit code.

## Design

- Age-based sweeping needs no lockfiles: a directory belonging to a live run
  is by construction younger than 24h. Prefix + location + age is a
  three-factor guard against deleting anything foreign.
- Making `npm test` mean "the suite CI enforces" removes the trap where the
  obvious command is the unreliable one; e2e remains one script away, and the
  documented flakiness note in 00-tdd.md stays the source of truth.
- Message fixes reuse each site's existing error type and warning channel.
  For the react-compiler and retry-budget-exhaustion sites this is a pure
  wording change. The Vite dev-server site needed one control-flow addition
  to satisfy the contract: no underlying `Error` reached that throw site
  before, so the boot call (`serverPool.acquire` / `bootServer`) is now
  wrapped in a try/catch that forwards whatever failed — including a
  non-`Error` thrown value — as `VITE_START_FAILED`'s detail, chained via
  `{ cause }`. The wrap changes nothing about when or whether boot fails,
  only what the resulting error says.

## Deferred

- Page-error buffer cap (20 distinct messages) silently dropping later
  distinct errors with only a count — low-likelihood; wants a real-world
  reproduction before adding buffer complexity.
- A distinct exit code or named error class for retry-budget exhaustion so CI
  can auto-requeue environment failures — wants a CI-owner's perspective
  (same reasoning as M46's deferred hostile exit code).
