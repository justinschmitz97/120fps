---
kind: milestone
status: implemented
tests:
  - test/unit/m54-baseline-reachability.test.ts
  - test/unit/m54-baseline-reachability-harden.test.ts
---

# M54 — baseline reachability

## Purpose

The baseline workflow was silently unreachable in the most common case. Matrix
mode — which auto-activates for any component with ≥2 boolean/union axes —
returns from `analyze` without ever calling the baseline workflow, so
`--save-baseline` wrote nothing and `--check` compared nothing, with no warning.
The verdict-reuse fast path (M39) required `--check` with *no* explicit mode
flags, so the `--no-matrix` a user must pass to save a baseline for such a
component also disqualified every future check from reusing it. `--no-cache` was
parsed but absent from `KNOWN_FLAGS`. `--curve --matrix` resolved curve-wins in
silence.

## Contract

- A matrix run that was given a baseline flag pushes `MATRIX_BASELINE_WARNING`
  onto `Report.warnings`, naming the limitation and `--no-matrix` as the
  workaround. It fires for auto-activated and explicit `--matrix` alike.
  `baselineWorkflowRequested(options)` is the condition: `--save-baseline`, or
  `--check` (which `--budget` implies) without `--no-baseline`.
- `optionsAllowVerdictReuse(options)` is the option-only half of the M39 reuse
  gate: check mode, no `--no-cache`/`--no-baseline`/`--save-baseline`, no
  isolation, `baselineEnv` at `normalize`, and each of `curveMode`/`matrixMode`
  either `undefined` or `false`. An explicit *enable* still always measures.
  The remaining conditions (entry fingerprint + `pass` + `env`, fingerprint
  match, `sameMachineIdentity`) are unchanged.
- `--no-cache` appears in `KNOWN_FLAGS` and in `helpText()`.
- `--curve` with `--matrix` is a usage error (exit 2): `"--curve cannot be
  combined with --matrix"`. A disable (`--no-curve`/`--no-matrix`) resolves the
  conflict rather than erroring, matching disable-wins everywhere else.
- `resolveCurveOption` / `resolveMatrixOption` (src/cli.ts) encode the flags for
  `analyze`, alongside `resolveIsolationOption` and `resolveReactCompilerFlag`.
  A disable resolves to `false`, an absent flag to `undefined` — the
  distinction the reuse gate reads.
- README lists every `KNOWN_FLAGS` entry in its options block (guarded by test),
  documents verdict reuse and what disqualifies it, defines the `warn` verdict
  and CV, and states that `tsconfig.json` is optional.
- Unchanged: the fingerprint schema, every other reuse guard, and what any run
  measures without these flags. The check-mode probe still fingerprints the
  *requested* sample count (M53), so a sample-throttled entry fails reuse and
  the run measures.

## Design

- The reuse relaxation is sound because `mode` is a feature field of the
  environment fingerprint: `featuresDiffer` rejects a slot whose mode is not
  the probe's `combo`, and `sameMachineIdentity` already guards the machine. A
  `--no-matrix --check` run reproduces exactly the distribution a combo-mode
  slot recorded. M39's "explicit flags always measure" rule existed to keep
  unfingerprinted flag effects out of reuse; mode-disable flags have no effect
  *beyond* the fingerprinted mode, so they are the one class it over-excluded.
- The warning is a `Report.warning`, not a stdout notice: it survives `--ci`
  (where `--budget` puts it), and reaches the markdown and JUnit outputs the
  same way every other run disclosure does.
- Supporting matrix baselines for real (per-cell slots) is a feature with its
  own schema questions — out of scope; the warning names the workaround.

## Deferred

- Matrix-mode baseline participation (per-cell entries, per-cell regression).
- Curve mode has the identical no-op: `--curve --save-baseline` stores nothing.
  Left alone here because the contract named matrix; the same
  `baselineWorkflowRequested` seam covers it when it is picked up.
- Deriving `KNOWN_FLAGS`/help parity from one source of truth so a flag cannot
  be added to the parser without appearing in help. The reverse-parity and
  README-drift tests catch the drift; they do not prevent it.
