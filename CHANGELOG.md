# Changelog

## 0.4.0

- Prop extraction binds to the exported/target component: internal helpers can no longer hijack the schema. `#ExportName` targets a specific export.
- Render crashes surface: page errors attach per combo, zero DOM + a throw = `FAIL [render error]` instead of a silent pass. Crash messages name phase, combo, and a fix hint.
- Prop synthesis: cva `VariantProps` unions enumerate, tuples and domain objects get real values, Maps/Sets degrade loudly, duplicate combos de-duped.
- Scale-probe combos labeled `×N copies` (`scaleProbe` in JSON); `--max-combos` bounds matrix mode; combo counts reconcile; expensive probes capped with a notice.
- Curve classification is stable (significance gates, no more linear↔quadratic flips); curve FAILs name the budget and crossing point; explicit `--curve` warns when nothing is curveable.
- Animation detection uses running animations, not declared CSS; animation/portal is a tier floor, not an override.
- Cost attribution reports mean scripting per mount (was: sum over all samples); `useReducer` dispatch / `useState` setters no longer flag as callback-identity problems.
- Next.js shim usage reported again (`nextJsShims`).
- `--explain-props` dry run; phase progress lines + `Total:`; provider-hook hints on render failures; `report.mode`; `--json` split notice on multi-component runs; memo/forwardRef names resolve in attribution.

## 0.3.0

**Upgrading:** metrics revisions bumped: every 0.2.x baseline classifies `incompatible`. Nothing fails; re-record with `--save-baseline`.

New modes:

- `--compare <gitref>`: interleaved A/B against a git ref, informational
- `--report-md` / `--report-junit`: PR-comment markdown and JUnit XML

New inputs:

- directories and globs (`npx 120fps "src/components/**/*.tsx"`)
- `<stem>.props.tsx` prop presets
- wrapper `setup()` / `teardown()` (async, awaited before first render)
- project transforms (svgr, vanilla-extract) loaded from your `node_modules`

Measurement honesty:

- measured-state disclosure (`pending-network`, `late-mutation`)
- noise sentinel: `quiet` / `noisy` / `hostile` machine classification
- server-only preflight fails in seconds naming the import chain
- volatile DOM (timestamps, random ids) no longer mints phantom states
- remediation hints with README anchors

Statistics: type-7 P95, sample-variance CV, per-combo warmups, churn parity, per-event interaction budgets.

Baselines: per-environment slots (laptop and CI don't collide), 90-day pruning, verdict reuse for unchanged components (`cached: true`, `--no-cache` to force).

Performance: shared Chromium pool + one Vite server per project, begin-frame pacing (~2 ms vs ~33 ms per fence), shared prop-extraction program cache. 385s → 300s matrix, 97s → 81s composed, before pooling.

Also: `--max-combos` / `--explore-budget` disclose caps, `--init-fixture`, `--no-cache` / `--no-preflight` / `--no-transforms`, matrix-baseline warning, scroll/wheel stress, `npm test` = unit only.

## 0.2.1

- Fixed interaction attribution and reporting in matrix mode.

## 0.2.0

- Global stylesheet injection with a font/style settle gate.
- Provider wrapper (`--wrap`, auto-detected `120fps.setup.tsx`).
- React Compiler awareness: compiled projects are measured compiled.
- Baseline environment fingerprints, `--baseline-env strict|normalize|ignore`.
- `--isolate` pipeline (mount, rerender, unmount, memory, strictmode).
