---
kind: milestone
status: approved
tests: test/unit/m29-baseline-env.test.ts, test/unit/m29-baseline-env-harden.test.ts, test/e2e/baseline-env.test.ts
---

# M29 — baseline environment fingerprint

## Purpose

A baseline entry stores per-component timings and nothing about the machine or configuration that produced them, and `compareBaseline` compares raw milliseconds against ±10/15/15/20% tolerances. That is only sound when both runs happened under the same conditions. Otherwise a CI runner difference, a Chromium upgrade, or a newly enabled stylesheet/wrapper/compiler reads as a code regression, and a baseline saved in one measurement mode silently compares against a run in another.

The fingerprint records what the run actually was, so every comparison states which comparison it is doing.

## Non-goals

- Making cross-machine comparison *accurate*. Calibration narrows the gap; it does not close it. This milestone makes the tool honest about which comparison it is doing, not omniscient.
- Per-branch or per-commit baseline history.
- Uploading or fetching baselines from a service.
- Retuning tolerances.

## Contracts

### E1 — persisted fingerprint

- New type:
  ```ts
  export interface EnvFingerprint {
    shape: 1;
    cpu: string;
    cores: number;
    os: string;
    nodeVersion: string;
    chromiumVersion: string;
    cpuThrottle: number;
    samples: number;
    calibrationTotalDuration: number;
    calibrationScriptDuration: number;
    mode: "combo" | "curve" | "matrix" | "isolation";
    css?: string[];
    wrapper?: string;
    reactCompiler?: boolean;
  }
  ```
- `BaselineEntry` gains `env?: EnvFingerprint`. Optional for backward compatibility (E6).
- `buildEnvFingerprint()` constructs it; `saveBaseline` persists it as part of the entry. `cpuThrottle` and `samples` are the effective values used for that run, not the CLI defaults. `css`/`wrapper` are `projectRoot`-relative posix paths; all three feature fields are omitted when inactive.
- `Baseline.version` stays `1`. The entry-level `shape` field versions the fingerprint independently, so adding fields later does not invalidate whole baseline files.
- Producers, in landing order **M26 → M29 → M25 → M27 → M28**: `wrapper` from `Report.wrapper.path` (M26), `css` from `Report.css.files` (M25). `reactCompiler` (M27) is declared here and always omitted until that milestone wires it; an omitted value classifies as equal against another omitted value, so pre-wiring baselines stay comparable.
- Reachability: baseline save/check runs only in combo mode today — both blocks sit after the curve/matrix early returns in `analyze()` — and in isolation mode once M28 lands. `mode: "curve" | "matrix" | "isolation"` values are declared for forward compatibility; no CLI path produces them yet, so tests synthesize them by patching JSON.

### E2 — classification

`classifyEnv(baseline: EnvFingerprint | undefined, current: EnvFingerprint): "identical" | "normalizable" | "incompatible" | "unknown"`, a pure function:

- `unknown` — no fingerprint in the baseline (pre-M29 file).
- `incompatible` — `mode` differs, or any of `css` / `wrapper` / `reactCompiler` differ. `css` compares by sequence equality (order affects the cascade); an omitted feature field equals only another omitted one. These change *what is measured*; no arithmetic rescues them.
- `identical` — `cpu`, `cores`, `os`, `chromiumVersion`, `cpuThrottle`, and `samples` all match, and the two `calibrationTotalDuration` values are within 10% of each other (`|a−b| ≤ 0.1 × max(a,b)`; when either is non-positive, only exact equality counts).
- `normalizable` — everything else: same measurement configuration, different or drifted hardware.

`nodeVersion` is recorded but deliberately excluded from classification: it does not affect in-browser timings. `calibrationScriptDuration` is recorded but not classified (E7).

`describeEnvDiff(baseline, current): string[]` renders the field-level differences behind a classification. Empty when `identical`. `["baseline has no environment record"]` when the baseline has no fingerprint. `nodeVersion` never appears, so an `identical` pair never produces mismatch text.

### E3 — comparison strategy

`compareBaseline(entry, current, tolerance, unstableMetrics?, currentEnv?)`. The fifth argument carries the current run's fingerprint; the baseline's is `entry.env`. Called without it (library use, or `--baseline-env ignore`), classification is `unknown` and comparison is raw — pre-M29 behavior exactly.

- `identical` → raw millisecond comparison. Byte-identical to today's behavior.
- `normalizable` → **calibration-normalized** comparison. Each metric is divided by its own run's `calibrationTotalDuration` before applying the same tolerance. Each resulting `Regression`/`Improvement` carries `normalized: { baseline, current, deltaPercent }` alongside the unchanged raw `baseline`/`current`/`deltaPercent`, so the report shows both.
- `incompatible` → no comparison. `hasBaseline: true`, empty `regressions`/`improvements`/`missingInteractions`, populated `envMismatches`, and a warning naming the specific mismatches. MUST NOT fail the run.
- `unknown` → raw comparison plus the warning `` `Baseline has no environment record; comparing raw timings. Re-save with --save-baseline to enable environment checks.` ``
- Normalized comparison MUST additionally require an absolute floor: a metric is only a regression if the normalized delta exceeds tolerance **and** the raw delta exceeds 0.5 ms. Sub-0.5 ms movement is below what this harness resolves, and normalization amplifies it. A raw delta of exactly 0.5 ms does not qualify.
- Invariant: if either side's `calibrationTotalDuration` is not a finite positive number, a `normalizable` pair falls back to raw comparison and `envMismatches` gains `"calibration total duration missing; compared raw milliseconds"`. Normalization never divides by zero and never emits `Infinity`/`NaN`.
- Invariant: the baseline file is user-editable, so every stored fingerprint field is untrusted. `classifyEnv` and `describeEnvDiff` MUST NOT throw on a missing, null, or wrong-typed field; unrecognized values classify as differences.

### E4 — flag

- `--baseline-env <strict|normalize|ignore>`, default `normalize`. Invalid value → usage error, exit 2.
  - `strict` — anything other than `identical` is a check failure: `report.pass = false` (exit 1) with the classification and mismatches listed in `Report.warnings`. Not a usage error. For CI that pins its runner and wants drift to be loud.
  - `normalize` — E3 as written.
  - `ignore` — the current fingerprint is not passed to `compareBaseline`: always raw-compare, no environment warnings, never fails on environment grounds.
- `AnalyzeOptions.baselineEnv?: "strict" | "normalize" | "ignore"`.
- `envAdvisory(match, mismatches, policy) → { warning?: string; fail: boolean }` is the single pure decision point for warning text and check failure; `analyze()` only applies its result.

### E5 — reporting

- `BaselineComparison` gains `envMatch` (the `EnvMatch` union) and `envMismatches: string[]` — human-readable field-level differences, empty when `identical`.
- `formatBaselineSection` prints a line under the table derived from `envMatch`, followed by one indented line per mismatch:
  - `Environment: identical — comparing raw timings`
  - `Environment: normalizable — comparing calibration-normalized values`
  - `Environment: unknown — comparing raw timings`
- When `envMatch` is `incompatible`, the metric table is replaced by `Environment: incompatible — comparison skipped` plus the mismatch list.
- Normalized `Regression`/`Improvement` entries additionally render a `Normalized (÷ calibration total)` block under the table.
- Environment warnings are baseline-scoped: they exist only on the `unknown` and `incompatible` paths and under `--baseline-env strict`, i.e. only when a baseline is actually being compared. A run without a baseline comparison emits no environment warning at all. This classification is what makes a blanket per-run "timings are not comparable" warning unnecessary for M25's auto-injected stylesheets (M25 C6/C7).

### E6 — migration

- Baselines without `env` keep working (`unknown` path, raw comparison, warning). No forced re-save.
- `saveBaseline` always writes the current fingerprint, so a single `--save-baseline` upgrades an entry.
- Entries in one file may mix fingerprinted and non-fingerprinted forms; classification is per entry.

### E7 — honesty about normalization

- Calibration (`createCalibrationTrace`) is a 1000-span DOM insert plus a forced layout. It tracks layout- and paint-bound cost reasonably and script-bound cost poorly.
- Both `calibrationTotalDuration` and `calibrationScriptDuration` are persisted so a later milestone can normalize script-dominated metrics separately. This milestone normalizes everything by `calibrationTotalDuration` and documents that as a known approximation.
- The docs (README budget section) MUST state plainly: same-machine comparison is trustworthy; cross-machine comparison catches large regressions and will miss small ones.

## Design notes

- The fingerprint deliberately lives on the entry, not the file. Entries are saved at different times, possibly from different machines, and `saveBaseline` already merges into an existing `entries` map. Entries in one file may therefore mix shapes.
- `EnvFingerprint` and `EnvMatch` live in `report.ts` next to `MachineInfo`/`CalibrationResult`; `budget.ts` already imports from `report.ts`, so no import cycle is introduced.
- `calibrationTotalDuration` is computed on every run and `analyze()` hard-fails at zero, so it is always available at save time. A stored zero can only come from a hand-edited file, which the E3 invariant covers.
- `ComboReport.relativeMount` is the same normalization applied to a different purpose; E3 reuses the concept rather than inventing one.
- This milestone is what makes M25/M26/M27 safe to enable by default: each changes absolute timings, and each is a fingerprint field that turns a silent regression into a named mismatch. It closes M26's open gap that a baseline saved with a provider wrapper compared directly against one saved without.

## Wiring owed by later milestones

Both touch the single `buildEnvFingerprint(...)` call in `analyze()` that produces `currentEnv` (used by both the `--check` and `--save-baseline` blocks). Nothing else in M29 changes.

| milestone | field | what to pass |
|---|---|---|
| M27 | `reactCompiler` | `reactCompiler: true` when the harness ran through `babel-plugin-react-compiler`. Leave undefined when the feature is not in play, so existing baselines stay comparable. |
| M28 | `mode` | `mode: "isolation"` on the isolation path, and move the baseline save/check blocks so they are reachable from it. |

## Open questions

1. Should `chromiumVersion` mismatch be `normalizable` rather than part of `identical`? A Chromium upgrade genuinely changes performance; calibration partly absorbs it. Currently classified as `normalizable` by omission from the identical set — confirm that is the intent with a real upgrade.
2. Is 10% the right calibration-drift band for `identical`? Chosen to match the mount tolerance; no evidence yet.
3. Should `--baseline-env strict` be the default in `--ci`? Arguably yes for reproducibility, but it would break existing CI setups on upgrade. Deferred.

## Test plan

**Unit** (`test/unit/m29-baseline-env.test.ts`)
- `classifyEnv`: each classification independently — missing fingerprint, mode differs, each feature field differs, all-match with calibration within/outside 10%, hardware differs.
- `nodeVersion` differing alone yields `identical`.
- Normalized comparison arithmetic: a metric that scales exactly with calibration produces no regression; one that scales twice as fast does.
- The 0.5 ms floor suppresses a normalized-but-tiny delta; exactly 0.5 ms is suppressed.
- `incompatible` yields empty regressions, populated `envMismatches`, and does not set `pass = false`.
- `envAdvisory` at each classification × policy; flag parsing and invalid-value error.
- `saveBaseline` round-trip: fingerprint written, effective `samples`/`cpuThrottle` recorded (not defaults), feature fields omitted when inactive.
- Pre-M29 baseline file loads, compares raw, emits the `unknown` warning.
- A run with no baseline comparison emits no environment warning and no environment line.
- `formatBaselineSection` renders the environment line in each mode.

**E2E** (`test/e2e/baseline-env.test.ts`)
- Save a baseline against a real component, then check with a synthetically altered fingerprint (patched JSON) for each classification; assert `report.baseline.envMatch`, the mismatch text, and the warning text.
- Save with no wrapper, then check with a baseline claiming a wrapper: `incompatible`, named mismatch, empty regressions. The stylesheet equivalent is covered by M25's tests.
- Save and check unchanged on the same machine: `identical` or `normalizable`, never a feature mismatch, no environment warning. Calibration drifts under parallel test load, so the e2e asserts the round trip rather than pinning the classification; `identical` itself is unit-tested on the pure function.
- `--baseline-env strict` with a mismatched fingerprint: the CLI exits 1.
- `--baseline-env ignore` with an incompatible fingerprint: raw comparison, no environment warning.
