---
kind: milestone
status: approved
tests: test/unit/m29-baseline-env.test.ts, test/unit/m29-baseline-env-harden.test.ts, test/e2e/baseline-env.test.ts
---

# M29 — baseline env fingerprint

Raw-ms baseline comparison is only sound under identical conditions; the fingerprint makes every comparison state which comparison it is. Goal = honesty, not cross-machine accuracy.

Non-obvious:
- Fingerprint lives on the ENTRY, not the file — entries saved at different times/machines; one file may mix shapes. `shape:1` versions it independently of Baseline.version (adding fields never invalidates whole files).
- classifyEnv: unknown (no fingerprint — pre-M29 file) | incompatible (mode/css/wrapper/reactCompiler differ — these change WHAT is measured, no arithmetic rescues; css compared as ordered sequence — cascade; omitted equals only omitted) | identical (hw + chromium + throttle + samples match AND calibrationTotalDuration within 10%) | normalizable (rest).
- nodeVersion recorded, deliberately excluded (no effect on in-browser timings) — never appears in mismatch text. calibrationScriptDuration persisted but unclassified: calibration (DOM insert + forced layout) tracks layout/paint cost well, script cost poorly; a later milestone may normalize script-metrics separately.
- normalizable → each metric divided by its OWN run's calibrationTotalDuration; regression needs normalized delta > tolerance AND raw delta > 0.5ms (floor: below harness resolution, normalization amplifies noise; exactly 0.5 does not qualify). Non-finite calibration → raw fallback + named mismatch; never divides by zero, never emits Infinity/NaN.
- incompatible → comparison SKIPPED, warned, never fails the run.
- Baseline file is user-editable ⇒ every stored field untrusted: classify/describe never throw on missing/null/wrong-typed; unrecognized values classify as differences.
- `--baseline-env strict|normalize(default)|ignore`. strict: anything non-identical fails (pinned CI runners want drift loud). ignore: fingerprint not passed at all — pre-M29 behavior.
- Env warnings are baseline-scoped ONLY (unknown/incompatible/strict paths) — this is why M25's auto-CSS needs no blanket per-run warning.
- saveBaseline records EFFECTIVE cpuThrottle/samples (not CLI defaults). One --save-baseline upgrades an entry; no forced migration.
- Docs must say plainly: same-machine trustworthy; cross-machine catches large regressions, misses small ones.

Open: chromiumVersion as normalizable — confirm with a real upgrade; 10% calibration band unproven (matched mount tolerance); strict-by-default in --ci deferred (breaks existing CI on upgrade).
