---
kind: milestone
status: done
tests:
  - test/unit/m39-fingerprint.test.ts
  - test/unit/m54-baseline-reachability.test.ts
  - test/e2e/m39-cached-check.test.ts
---

# M39 — fingerprint-based baseline reuse

## Purpose

For identical code in an identical environment, re-measuring redraws the same
distribution — a check-mode run's answer cannot change. Skipping unchanged
components turns the routine CI sweep (1–5 changed components per commit)
into seconds while keeping full measurement on everything that changed.

## Contract

- `BaselineEntry` gains `sourceFingerprint?: string` and `pass?: boolean`
  (additive; `pass` records the saving run's verdict). Both are written on
  every `--save-baseline`.
- `computeSourceFingerprint(projectRoot, files, config)` hashes, order-
  independently: each file's project-relative posix path + content (missing
  files hash as missing), plus a config string. Inputs assembled by
  `analyze()`: the measured entry file's TypeScript import graph
  (`projectSourceFiles` — every program source file that is neither a
  default lib nor from an external library), the wrapper file, the resolved
  stylesheets, `tailwind.config.*` / `postcss.config.*` when present, the
  first lockfile hit (pnpm-lock.yaml / package-lock.json / yarn.lock), and a
  config string carrying resolved css/wrap/compiler flags, samples, and
  throttle. Feature drift is therefore fingerprint-covered; the environment
  check below only guards the machine.
- Reuse happens iff ALL hold: check mode, `--no-cache` absent, no explicit
  mode *enable* (`--matrix`, `--curve`, `--isolate` — auto-activation is a
  function of the fingerprinted source, an enable flag is not; an explicit
  *disable* resolves to the `combo` mode the entry already records and stays
  eligible, M54), `--baseline-env` at its default
  `normalize` (`ignore` explicitly requests a raw comparison and `strict` a
  hard verification of a real run — both measure), the entry carries
  fingerprint, `pass`, and `env`, fingerprints match, and
  `sameMachineIdentity(entry.env, probe)` holds. The probe carries the
  current run's REAL feature fields (css, wrapper, compiler state) plus
  machine identity, throttle, samples, and `METRICS_REVISION` — so a
  hand-edited or drifted env record breaks reuse through `featuresDiffer`
  exactly like it breaks classification in a measured run. Anything else
  measures normally.
- Calibration is deliberately NOT part of the reuse gate: a single
  calibration sample swings 20–40% on a real machine (measured 41.7 vs 57.3
  within one sweep of justinschmitz.de), so a ±10% closeness requirement
  made reuse a thermal lottery — and drift changes measured values, never
  the verdict of unchanged code. The probe therefore needs no page at all:
  it reads the pooled browser's version for machine identity. A cached
  report carries the entry's stored calibration (the run whose verdict is
  reused).
- A reused result is visible: `Report.cached: true`, `pass` from the entry,
  `combos: []`, a baseline block marked `identical` with no regressions, a
  terminal line naming the reuse. JSON is still written. Detailed mode
  output (matrix cells, curve points, isolation phases) is never
  reproduced — runs that ask for those measure.
- `--no-cache` CLI flag → `AnalyzeOptions.noCache`.

## Limits

- Tailwind emits utilities from project-wide content scanning; a class added
  in an unrelated file changes the compiled stylesheet without changing this
  fingerprint. The lockfile + config hashes bound the blast radius; a
  baseline refresh (`--save-baseline`, which always measures) is the
  correction path.
- Pre-M39 entries (no fingerprint/pass) never reuse.
