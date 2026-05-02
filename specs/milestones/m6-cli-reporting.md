---
kind: milestone
status: done
tests:
  - test/unit/report.test.ts
  - test/unit/analyze.test.ts
  - test/unit/cli.test.ts
  - test/unit/report-harden.test.ts
  - test/e2e/analyze.test.ts
  - test/e2e/cli.test.ts
---

## Purpose
Ship the user-facing tool. `npx 120fps ./Component.tsx` runs the full pipeline and produces a terminal summary + JSON report file. Programmatic `analyze()` API for library consumers.

## Contract

### MUST
- `analyze(componentPath, options?) → Report`: full pipeline orchestrator. Cleans up harness in all exit paths.
- `Report`: version=1, timestamp, machine info, calibration, combo reports, thresholds, pass boolean.
- `ComboReport`: mount/unmount `TimingWithCV`, interactions, scaling curve, `relativeMount` (mount.median / calibration.totalDuration), verdict.
- `TimingWithCV`: extends `TimingResult` with `cv` (stddev/|mean|×100) and `unstable` (cv>15%).
- Verdict: `fail` if any metric exceeds threshold. `warn` if any timing unstable but within thresholds. `pass` otherwise. `report.pass = no combo is "fail"`.
- CLI: `120fps <component.tsx> [--json path] [--ci] [--samples n] [--threshold-mount ms] [--threshold-interaction ms] [--help] [--version]`
- Without `--ci`: terminal table + JSON. With `--ci`: JSON only, exit 1 on fail, exit 2 on usage error.
- Terminal table: component name, machine summary, per-combo rows (mount, unmount, DOM, interactions, scaling, verdict), top 3 slowest interactions, unstable footnote.
- Default thresholds: mountMs=16, interactionMs=100, relativeMount=2.0.
- Machine info: CPU, cores, RAM, OS, Node version, Chromium version.
- Calibration runs before combos; zero-duration calibration → throw.

### MUST NOT
- Modify existing module contracts.
- Require configuration files.
- Add color dependencies.

### Invariants
- `Report.version === 1` always.
- Empty component → valid report with 1 combo, 0 interactions.
- CV of identical samples = 0.
- JSON round-trips (`JSON.parse(JSON.stringify(report))`) without loss.

## Design

### Modules
- `src/report.ts` — types, `computeCV`, `buildTimingWithCV`, `computeVerdict`, `formatTable`, `DEFAULT_THRESHOLDS`
- `src/analyze.ts` — `analyze()` orchestrator, `buildReport()` pure function, `detectComponentName`, `collectMachineInfo`
- `src/cli.ts` — `parseArgs()` pure function, `main()` with guarded execution

### Pipeline
1. Parse args → 2. buildAndServe → 3. Launch browser + CPU throttle → 4. Calibration → 5. Close browser → 6. measureMount → 7. explore → 8. buildReport → 9. Write JSON → 10. Print table → 11. Cleanup → 12. Exit

## Open
- Chromium version string format varies across Playwright versions.
- `--ci` avoids terminal formatting entirely (safe for all CI environments).

## Resolved
- Heap delta: `Runtime.getHeapUsage` before/after sample loop per combo, stored as `MountResult.heapDelta`.
- GC: `tryCollectGarbage(cdp)` called at top of sample loop in `measureMount()` and `exploreCombo()`.
- Scaling curve: `computeScalingCurve()` applied across combos when ≥2 distinct DOM sizes exist.
