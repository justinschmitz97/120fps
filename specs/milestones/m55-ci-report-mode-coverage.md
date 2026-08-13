---
kind: milestone
status: implemented
tests:
  - test/unit/m55-ci-report-mode-coverage.test.ts
---

# M55 — ci-report mode coverage

## Purpose

README promises the CI serializers "compose with every mode including cached
and isolation runs" (README.md:147). They do not. Curve, isolation, and cached
reports ship `combos: []` (src/analyze.ts:1131,1279; cached path likewise), but
`formatMarkdown`/`formatJUnit` read only `primary(report) = report.combos[0]`
(src/ci-report.ts:11-13,51-58) and iterate `report.combos` for failure detail
(src/ci-report.ts:110-116). For those modes `--report-md` prints `—ms`
placeholders in every cell, `worstVerdict` can never surface `warn`, and a
JUnit failure body degrades to the bare string `"failed"` — exactly the CI
surfaces a team gates scaling and leak checks on.

## Contract

- `formatMarkdown` and `formatJUnit` MUST render meaningful, mode-appropriate
  content for every report shape the pipeline produces:
  - standard (combos): unchanged;
  - curve: the measured scale points with their mount medians and the growth
    class, and on failure the classification that failed the verdict;
  - isolation: per-phase medians and the phase verdicts (leak bytes/cycle,
    churn degradation ratio, StrictMode overhead where present), and on
    failure the number that breached;
  - cached: the reused verdict, labeled as reused (no fabricated timings).
- `worstVerdict` MUST surface `warn` for all modes, not collapse to pass/fail.
- A JUnit `<failure>` body MUST carry the failing numbers for its mode, never
  the placeholder string `"failed"`.
- The markdown table MUST NOT print `—ms` placeholders when the report carries
  the data elsewhere (curve/isolation/cached fields); a genuinely absent
  metric stays a dash.
- Both serializers MUST remain pure functions of `Report` — no I/O, no forge
  API calls, no environment reads (existing invariant, M50).
- MUST NOT: change the `Report` JSON schema, or alter serializer output for
  standard combo reports beyond surfacing `warn` in `worstVerdict`.

## Design

- `reportMode(report)` is the single dispatch point (shared by both
  serializers): `combo` when `combos.length > 0` (covers standard and matrix
  — matrix cells are combos, so both render unchanged); else `cached` when
  `report.cached`; else `curve` when `scalingCurveReport` is set; else
  `isolation` when `isolation` is set; else `empty` — an unrecognized
  combos-less shape, which renders an explicit "no measurable data" instead of
  a dash. `combo` is checked first, so a hypothetically malformed report
  carrying both `combos` and `scalingCurveReport` still renders as standard.
- Table row content per mode (`modeTimings`): combo unchanged; curve shows the
  first→last scale point's mount/rerender medians plus the mount growth class
  (a single point collapses to one value, not a redundant range); isolation
  shows the isolated mount median and the rerender phase's `stable` median;
  cached and the unrecognized-empty case stay dashes — cached because nothing
  was measured (no fabricated timings), empty because "no measurable data" is
  the honest answer for both cells.
- A markdown-only `<details><summary>Mode detail</summary>` fold (separate
  from the pre-existing `Regressions` fold) lists every curve report's scale
  points and growth class, and every isolation report's per-phase medians
  (mount, rerender stable/prop-change/churn+degradation, unmount, memory
  leak bytes/cycle, StrictMode overhead) — always, not gated on failure,
  since both modes typically measure one component at a time and the
  "thirty-component comment" size concern that gates the `Regressions` fold
  does not apply. On failure, the same lines JUnit's failure body carries are
  appended.
- `worstVerdict` recomputes the mode's real verdict from data already on
  `Report`, since `report.pass` is a flattened boolean:
  - curve: `computeCurveVerdict(scalingCurveReport.points, scalingCurveReport.mountCurve, report.thresholds)`
    — the exact function `analyze.ts` uses to set `pass`, so it never drifts.
  - isolation: `warn` iff `isolation.strictMode` is present and
    `!doubleInvokeClean` — the one isolation-native condition
    `computeIsolationVerdict` (src/isolation.ts) documents as "warns, never
    fails". No other isolation signal (CV instability, etc.) is treated as
    warn, since the pipeline's own verdict function does not either.
  - `fail` always wins over `warn` (`!report.pass` is checked first).
- Failure detail (`curveFailureLines` / `isolationFailureLines`) mirrors the
  pipeline's own fail predicates so the numbers never drift from what actually
  failed the run:
  - curve: growth class quadratic/exponential, or any scale point's
    mount/rerender median over `report.thresholds`.
  - isolation: memory leak bytes/cycle over the imported `LEAK_BYTES_PER_CYCLE`
    constant, or churn degradation over the imported `CHURN_DEGRADATION_LIMIT`
    constant — both read directly from `src/isolation.ts`, not
    reimplemented. Mount has no stored budget on `Report` (isolation resolves
    a tiered budget that `analyze.ts` does not persist), so a mount-budget
    fail is reported by elimination: only when leak and churn did not already
    explain the failure, and only as "exceeds this component's mount budget"
    (no specific number is invented). Both helpers are shared verbatim
    between the markdown fold and the JUnit failure body — the CI comment and
    the JUnit report always agree.
  - cached: a fixed message ("reused failing verdict from baseline ...
    rerun with --no-cache to measure fresh numbers") — cached fail carries no
    per-metric numbers to report.
  - Every branch is guaranteed non-empty (a generic fallback line covers the
    rare case where `pass` was flipped by something outside the mode's own
    predicates, e.g. a baseline-comparison override), so the JUnit
    `<failure>` body is never the bare string `"failed"`.
- Component paths are escaped for the markdown table (`\|`) since a literal
  pipe in a path would otherwise misalign the table.
- JUnit stays one testcase per component; mode detail lives in the testcase
  body, keeping every CI system's native rendering intact.
- Verify against the README's own composition claim: after this milestone the
  claim is true.

## Deferred

- A machine-readable mode discriminator field on `Report` (explicit
  `report.mode`) so serializers stop inferring mode from populated fields —
  schema addition, wants its own milestone if inference proves fragile.
- Markdown rendering of matrix cell tables (matrix reports carry combos and
  render today; a per-axis breakdown table is an enhancement, not a gap).
- An exact isolation mount-budget number in the JUnit/markdown failure detail.
  `analyze.ts` resolves a tiered budget for isolation mode that is not
  persisted on `Report`; without a schema change (out of this milestone's
  scope) the serializer can only report a mount fail by elimination, not the
  budget it breached.
