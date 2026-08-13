---
kind: milestone
status: implemented
tests:
  - test/unit/m49-compare.test.ts
  - test/e2e/m49-compare.test.ts
---

# M49 — compare mode (interleaved A/B)

## Purpose

The most common perf question is relative: "did my change make it faster?"
Without this it takes save-baseline → check, and the two runs sit in different
thermal and contention windows. The project's own benchmarking discipline
(interleaved same-window A/B, never sequential totals) exists precisely because
sequential comparison lies; users get the same discipline as a first-class mode.

## Contract

- `--compare <gitref>` measures the working tree against `<gitref>`. The killer
  path is `--compare HEAD`: "I just edited, is it better."
- The reference side materializes via `git worktree add --detach` into a temp
  dir. Both sides build harnesses, and **samples interleave**: sample *i* of the
  working tree, then sample *i* of the reference, alternating, in one window,
  over the same pooled browser (M37). Sequential whole-run-then-whole-run is
  what this mode exists to replace.
- Scope: mount, unmount and DOM node count per combo. Explore/interactions are
  excluded — their wall clock would dominate, and matching interactions across
  changed DOM is its own problem.
- Combos generate from the **working tree's** schema: it is the side the user is
  asking about, and a prop it does not have is not a question they asked.
- `distinguishable` compares sample **ranges**, not means: only non-overlapping
  spreads say the difference outlived the noise. Deliberately not a t-test — no
  statistics machinery until the heuristic proves insufficient.
- No verdict, no exit-code semantics: compare informs a human, budgets and
  baselines keep owning CI. Exit 0 unless the run itself failed.
- Mutually exclusive with `--check`, `--save-baseline`, `--isolate`
  (`validateCompareOptions`). A non-git project, an unknown ref, and a component
  that does not exist at the ref are all clear errors, not crashes.
- The worktree is removed on every exit path, including failure.

## Design

### The reference side has no install of its own

The draft's open question, answered: a fresh worktree has no `node_modules`, so
the reference harness cannot resolve `react` and fails at readiness. Two v1
candidates were considered — restrict `--compare` to refs whose lockfile matches,
or share the working tree's install. Both are implemented, and they compose:
the lockfile hash of the two sides must match (`DEPENDENCY_DRIFT_ERROR`
otherwise), which is exactly what makes linking the working tree's
`node_modules` into the worktree sound. The link is a junction on Windows (no
privileges required), a directory symlink elsewhere.

### Interleaving granularity

Per-sample, the tightest window available. The alternative — alternating
half-batches with fewer page switches — trades window tightness for navigation
overhead, and there is no measurement yet showing that trade is worth making.
`runMountUnmount` is reused for both sides, so the two are measured by exactly
the same code path.

## Deferred

- Rerender timings and scaling curves per side. The measurement helper reused
  here covers mount and unmount; curves would double an already-doubled run.
- Interactions, for the reasons in the contract.
- Per-side fixture/wrapper/CSS resolution and disclosure when they differ.
- Nested workspace packages: the `node_modules` link is made at the repo root,
  so a component resolving through a nested package's own install is not
  covered.
- A prop present on only one side, reported as non-comparable — combos come from
  the working tree, so today the reference simply receives them.
