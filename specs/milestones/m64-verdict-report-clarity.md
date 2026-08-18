---
kind: milestone
status: implemented
tests:
  - test/unit/m64-verdict-report-clarity.test.ts
  - test/unit/m64-harden.test.ts
  - test/e2e/m64-observed-animation.test.ts
---

# M64 — verdict & report clarity

## Purpose

Eight output defects found during the 2026-08-18 dogfood run, each one a place
where the report states something that is not true of the run it describes. A
negative compound delta printed as "above additive expectation". WARN rows under
"Result: PASS" with no stated rollup rule. A hostile-machine warning that claims
a baseline comparison was skipped when none was requested, in a vocabulary the
JSON does not use. A `Report` whose mode consumers must infer from which field
is populated. A "React Optimizations" header over nothing. `hasAnimation` true
for a declared-but-idle Tailwind `transition-all`, which then overrode the tier
of a 6-node toolbar to T3. Render attribution reading names off a `memo`/
`forwardRef` wrapper that carries none. And `--help` documenting neither the
exit codes, nor what `--json` does to a multi-component run, nor that
`--max-combos` does not bound matrix mode.

## Contract

### 1 — compound-effect sign

- The matrix compound-effect line MUST read "above additive expectation" only
  for a non-negative `compoundDelta`, and "below additive expectation" for a
  negative one.
- MUST NOT change `CompoundEffect` values, significance classification, or which
  effects are reported.

### 2 — WARN rollup note

- When a run passes and at least one combo (or matrix cell) carries verdict
  `warn`, the terminal MUST print one line under `Result: PASS` naming how many
  rows warned and stating that warnings do not fail the run.
- MUST NOT print the note on a failing run (the FAIL already explains itself),
  and MUST NOT change `report.pass`.

### 3 — noise warning wording

- `HOSTILE_RUN_WARNING` and `NOISY_RUN_WARNING` MUST NOT assert anything about a
  baseline. The baseline clauses live in `HOSTILE_BASELINE_NOTE` /
  `NOISY_BASELINE_NOTE` and are appended only when a baseline comparison was
  actually applicable to the run.
- `formatNoiseWarning(noise, baselineCompared)` MUST prefix the sentence with
  the classification level and the probe signals behind it — probe CV, share of
  metrics flagged unstable, and context retries when any occurred.
- The terminal MUST render the enriched sentence in every output mode;
  `report.noise` keeps carrying the same signals structurally, so terminal and
  JSON name the same facts.
- "A baseline comparison was applicable" MUST be read off the report alone:
  `report.baseline !== undefined`, which `analyze.ts` sets only when `--check`
  ran against an existing entry.

### 4 — `report.mode` discriminator

- `Report` MUST carry an optional `mode?: ReportMode` with the vocabulary
  `EnvFingerprint.mode` already uses: `"combo" | "curve" | "matrix" |
  "isolation"`.
- `deriveReportMode(report)` MUST return that mode from the populated fields, so
  a report written before the field existed still resolves.
- `describeMode` (terminal mode line) and `ci-report.ts`'s serializer dispatch
  MUST both route through the field-or-derivation, never through their own
  inference.
- MUST NOT make the field required: every baseline entry, cached report, and
  third-party consumer predates it.

### 5 — empty React Optimizations sections

- The "React Optimizations" header MUST print only when at least one combo has a
  finding to show, and the `Combo #N:` sub-heading only for combos that do.
- A combo has content when any of these is set: `durationsUnavailable`,
  `memoBailout` with components, `contextFanOut` with components, a non-empty
  `callbackIdentityDeltas`, `portalOrphans > 0`, non-empty `renderAttribution`.
- MUST NOT change what is printed for a combo that does have findings.

### 6 — observed animation, tier floor

- `detectAnimations` MUST report only animation observed in the page:
  an `Animation` object from `document.getAnimations()` whose effect target is
  inside `#root` and whose `playState` is not `"idle"`.
- It MUST NOT infer animation from computed style — neither a declared
  `transition-property`/`transition-duration` pair (Tailwind `transition-all`
  on an idle element) nor a declared `animation-name`. A transition that
  actually runs, and a CSS animation that actually runs, both appear in
  `getAnimations()`.
- `classifyTier` MUST treat portal and animation as a **floor** of T3, not an
  override: the DOM-size tier applies when it is already higher. A 2000-node
  animated table is T4; a 30-node animated panel is T3; a 6-node portal is T3.
- MUST NOT change the DOM-size boundaries (≤10 T1, ≤40 T2, else T4) or any
  tier's budget.

### 7 — render attribution unwrapping

- The profiler hook MUST resolve a fiber's component name through
  `React.memo` (`{$$typeof, type}`) and `forwardRef` (`{$$typeof, render}`)
  wrappers, in any nesting order, before falling back to `"Anonymous"`.
- Resolution MUST be depth-bounded so a malformed or cyclic type cannot hang the
  commit hook.
- Known limit, not a defect: `memo((props) => …)` with a literally anonymous
  arrow has no name at runtime and stays `"Anonymous"`.

### 8 — CLI documentation and `--json` announcement

- `--help` MUST document the exit codes (0 pass / 1 verdict fail / 2 setup
  error), that `--json` becomes a per-component filename template on a
  multi-component run and the named path is never written, and that
  `--max-combos` does not bound matrix mode.
- A multi-component run MUST print one line naming the JSON files written.
- Documentation only: `--max-combos` behavior in matrix mode is out of scope.

## Design

- **Warning enrichment at render time.** `analyze.ts` pushes the bare noise
  constant into `report.warnings`; `report.ts` substitutes the enriched sentence
  as it prints, composing it from `report.noise` and `report.baseline`. One
  substitution point (`appendWarnings`) covers combo, curve, matrix and
  isolation output, and the JSON keeps a sentence that claims nothing untrue.
- **Mode as data, shape as dispatch.** `report.mode` answers "which measurement
  was this"; `ci-report.ts` still needs to know which field carries the numbers,
  so it keeps the `combos`/`cached` shape checks first and takes curve vs
  isolation from the mode. Both sides now read one derivation.
- **Floor over override.** Tier budgets rise monotonically T1→T4, so "floor at
  T3" is `max(sizeTier, T3)`. The override was only ever a floor that also
  capped, and the cap is what mis-classified large animated components.
- **Page-side rules as source strings.** The animation rule and the fiber-name
  resolver are exported as JavaScript source (`OBSERVED_ANIMATION_EXPRESSION`,
  `FIBER_TYPE_NAME_SOURCE`) and injected into `page.evaluate` / the profiler
  hook. One definition, and both are unit-testable against stub objects without
  a browser.

## Deferred

- `report.mode` is defined and consumed but never assigned: both assignment
  seams are in `analyze.ts`, owned by a concurrent milestone. Two lines
  (`report.mode = deriveReportMode(report)` before each `writeReportJson` call)
  complete it; until then every consumer falls back to the derivation and no
  JSON carries the field.
- `--max-combos` bounding matrix mode (documented here, fixed elsewhere).
- README's CLI block does not repeat the exit codes; `--help` is the contract
  surface this milestone owns.
- Animation observed only during an interaction, or starting after the
  first-sample detection point, still reads as no animation. Detection stays a
  single post-mount read (M34's overhead budget).
