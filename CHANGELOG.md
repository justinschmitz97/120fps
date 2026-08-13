# Changelog

## 0.3.0

### Upgrading — your saved baselines will stop gating

This release changes what the numbers mean, three times over: DOM counts became
component-scoped, per-sample GC moved outside the CPU throttle, and lifecycle
measurement left vsync pacing behind. Each is recorded as a metrics-revision
bump, so **every baseline saved by 0.2.x now classifies `incompatible`**.

Nothing breaks and nothing fails: `--check` names the mismatch, skips the
comparison, and leaves the run's exit code to budget verdicts alone. But the
baseline stops catching regressions until you re-record it:

```bash
npx 120fps "src/components/**/*.tsx" --save-baseline
```

Baseline files themselves upgrade in place — version-1 files load, and their
entries are rekeyed into the environment slot their own record describes.

### New modes

- `--compare <gitref>` — measure the working tree against a git ref with samples
  interleaved per sample in one window, instead of comparing two runs from
  different thermal windows. No verdict, no exit code; budgets and baselines
  keep owning CI.
- `--report-md <path>` / `--report-junit <path>` — GitHub-flavored markdown
  summary and JUnit XML, both written even when components failed. Compose with
  every mode. 120fps emits what forges consume and never talks to a forge.

### New inputs

- **Directories and globs.** `npx 120fps "src/components/**/*.tsx"` expands
  files, directories and glob patterns, skipping tests, stories, fixtures and
  declarations. PowerShell does not expand globs, so on Windows this is the only
  way to sweep a directory.
- **Prop presets.** A `<stem>.props.tsx` next to the component supplies real
  prop values without authoring a scene. Values replace the synthesized pool
  everywhere — combos, deltas, matrix cells, curve anchors.
- **Async wrapper setup.** The provider wrapper may export `setup()` (awaited
  before first render, so request mocks and seeded stores are in place) and
  `teardown()`. A connected component measures its real scene instead of its
  skeleton.
- **Project transforms.** Projects declaring `vite-plugin-svgr` or
  `@vanilla-extract/vite-plugin` get that plugin loaded from their own
  `node_modules`. Transforms that cannot be loaded are now named with a stable
  code (`[transform:svgr]`) instead of failing deep inside Vite.

### Honesty about what was measured

- **Measured state.** A component still fetching or mutating when the sample
  window closed is disclosed as `pending-network` or `late-mutation` rather than
  reported as a settled number.
- **Noise sentinel.** Every run classifies the machine `quiet`/`noisy`/`hostile`.
  A noisy run stops baseline regressions from failing; a hostile run skips
  baseline comparison entirely. Budget verdicts are absolute and unaffected.
- **Server-only preflight.** A component whose import graph reaches
  `server-only`, a `"use server"` directive, or an async component now fails in
  seconds naming the chain, instead of timing out minutes in. `--no-preflight`
  bypasses it.
- **Volatile DOM.** Components rendering timestamps or random ids no longer mint
  a new state node per interaction; content churn inside a volatile region stops
  counting as state, structural change through it still does.
- **Remediation hints.** Each finding class prints the action that addresses it
  plus a README anchor.

### Statistical corrections

These change reported numbers slightly, in the direction of being correct:

- P95 is now the type-7 interpolated quantile (R/numpy default). Below n≈20 it
  is documented as "the slow end of what was measured", not a population
  percentile.
- CV now uses the sample standard deviation (n−1 denominator).
- Every combo — not just the first — gets an untraced warmup on its own props,
  removing the cold-start artifact from later combos' tails.
- Churn degradation and its stability flag are computed within one alternation
  parity, never across the A/B prop mix.
- Interaction budgets are per event, derived from frame budgets under 4× CPU
  throttle, and `pointer-drag` now bills its 60 moves rather than one step.

### Baselines

- **Per-environment slots.** Entries are keyed by component *and* an environment
  digest, so your laptop and the CI runner each get a slot in the same committed
  file instead of overwriting each other. No slot for this machine means the run
  compares against the freshest other slot, says so, and cannot fail. Slots
  untouched for 90 days are pruned on save.
- **Verdict reuse.** In check mode, a component whose sources and machine are
  unchanged reuses its stored verdict instead of re-measuring — identical code in
  an identical environment redraws the same distribution. Marked `cached: true`.
  `--no-cache` forces measurement.

### Performance

A sweep no longer pays per-component setup:

- One Chromium pool (driven + vsync) for a whole sweep instead of ~5 launches
  per component; one Vite dev server per project/config tuple instead of one per
  component.
- Lifecycle measurement drives frames via begin-frame control, so a double-rAF
  fence costs ~2ms instead of ~33ms of vsync idle.
- Prop extraction shares a parsed-program cache across calls instead of
  re-parsing `lib.d.ts` and the project's type graph each time.
- Per-sample GC runs unthrottled; per-combo facts are read once, not per sample.

Measured against a real repo: 385s → 300s on the matrix path, 97s → 81s on the
composed path, before the pooling work above.

### Also

- `--max-combos <n>` and `--explore-budget <seconds>` expose bounds that were
  previously silent truncation. Capped combos are now disclosed in
  `Report.warnings` rather than applied invisibly.
- `--init-fixture` writes a starter fixture when auto-composition is rolled back.
- `--no-cache`, `--no-preflight`, `--no-transforms` added.
- A matrix run given a baseline flag now warns that matrix reports do not
  participate in baselines, naming `--no-matrix` as the workaround.
- Scroll and wheel interactions are exercised (`scroll-sweep`), covering
  virtualized lists.
- `npm test` now runs the unit suite only, matching CI; `npm run test:e2e` and
  `npm run test:all` cover the rest.

## 0.2.1

- Fixed interaction attribution and reporting in matrix mode.

## 0.2.0

- Global stylesheet injection with a font/style settle gate.
- Provider wrapper (`--wrap`, auto-detected `120fps.setup.tsx`).
- React Compiler awareness — projects shipping compiled output are measured
  compiled.
- Baseline environment fingerprints and `--baseline-env strict|normalize|ignore`.
- `--isolate` execution pipeline (mount, rerender, unmount, memory, strictmode).
