---
kind: milestone
status: implemented
tests:
  - test/unit/m45-baseline-slots.test.ts
  - test/e2e/baseline-env.test.ts
---

# M45 — per-environment baselines & baseline workflow

## Purpose

Teams commit one `120fps-baseline.json`; developer laptops and CI runners then
collide into `normalizable`/`incompatible` classifications (M29) that users read
as tool errors. M29 built the machinery to *classify* environment mismatch; this
milestone changes the model so the mismatch mostly stops occurring. Baselines
become per-environment slots, and cross-environment comparison becomes an
explicit informational fallback instead of the accidental default.

## Contract

- Baseline entries are keyed by component **and** environment. `computeEnvKey`
  digests the machine-identity fields `sameMachineIdentity` (M39) already
  checks: metrics revision, CPU model, cores, OS, Chromium **major** version,
  throttle, sample count, mode, stylesheets, wrapper, React Compiler.
- Save writes the current environment's slot. Check reads it.
- Check with no slot for this environment falls back to the component's freshest
  other slot, sets `BaselineComparison.crossEnvironment`, emits
  `NO_ENV_BASELINE_WARNING`, and **cannot fail the run** — a cross-machine delta
  is not evidence of a regression.
  - `--baseline-env ignore` is the exception: it means the user asked for a raw
    cross-environment comparison and accepts what that implies, including
    failure. No fallback marking, no advisory.
  - `--baseline-env strict` keeps its meaning; its advisory still fails a
    drifted check, so slots do not weaken it.
- M39 fingerprint reuse operates per slot: only a slot carrying an environment
  record can supply a reusable verdict.
- File format is version 2. A version-1 file loads unchanged: its plain
  component keys are rekeyed in memory into the slot their own recorded `env`
  describes, and entries with no `env` land in a `legacy` slot — readable,
  never written.
- Keys are written sorted, so two branches that baseline different components
  merge textually.
- Slots not updated in `BASELINE_SLOT_TTL_DAYS` (90) are pruned on save and
  named in `PRUNED_SLOTS_NOTICE`. A slot with no `savedAt` predates M45 and is
  kept: absence is not age. The slot just written is never pruned.
- README documents the workflow: baseline authority in CI (save on main, check
  on PRs), local slots personal and optionally skip-worktree'd.

## Design

- **Composite keys (`<component>#<envKey>`) rather than a nested object.** The
  map stays `Record<string, BaselineEntry>`, so every existing reader keeps its
  shape; sorted keys still group by component; a text merge of two branches
  touching different components still succeeds. Nesting would have bought
  readability in the file at the cost of churn in every consumer.
- The digest **excludes calibration** on M39's evidence: a single calibration
  sample swings 20–40% on a real machine, so gating slots on it would fragment
  them by thermal luck. It **excludes the Chromium patch version** (bumps land
  weekly, no measured timing effect) but keys on the major.
- Per-component baseline *files* (a `120fps-baselines/` directory) were
  considered for merge-friendliness and rejected: sorted single-file diffs
  already merge cleanly when different components change, and a directory
  complicates discovery and gitignore patterns.

### Consequence for M28's mode classification

A combo baseline and an isolation baseline no longer share a key, so the
`incompatible` classification for that pair now arises only through the
cross-environment fallback (when no isolation slot exists yet). The
classification is unchanged; the collision it was built to explain mostly stops
happening.

## Hardening

| # | Hypothesis | Result |
|---|---|---|
| H1 | Two machines overwrite each other's numbers | Pass — separate slots |
| H2 | Calibration drift fragments slots | Pass — excluded from the digest |
| H3 | A Chromium patch bump fragments slots | Pass — major version only |
| H4 | A feature change silently shares a slot | Pass — wrapper/compiler/throttle all key |
| H5 | A version-1 file stops loading | Pass — rekeyed in memory |
| H6 | Pruning drops the slot just written | Pass — never |
| H7 | Pruning drops a pre-M45 slot with no timestamp | Pass — kept |
| H8 | Concurrent branches produce unmergeable diffs | Pass — keys sorted on write |

## Deferred

- A user-named environment alias (`--env-name linux-ci`) overriding the digest,
  for heterogeneous CI fleets behind one label. Needs a real fleet to test
  against; without one, encoding it would be guesswork.
- Whether pruning belongs in an explicit `--prune-baselines` rather than in
  save.
