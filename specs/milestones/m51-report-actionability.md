---
kind: milestone
status: implemented
tests:
  - test/unit/m51-hints.test.ts
---

# M51 — report actionability

## Purpose

The report named the finding (`memoBailout` in `<Row>`, quadratic growth,
Chart.js 60% of mount) but not the move: users without deep React perf
background stared at a correct diagnosis with no treatment. Separately, first-run
users misread throttled milliseconds as absurd ("my button takes 14ms?"), and
the modes had no "which one answers my question" guide. All three are
presentation gaps; none required new measurement.

## Contract

- Every warning-class finding maps to a hint: 2–3 lines of concrete direction
  plus a stable README anchor. Classes: `memoBailout`, `contextFanOut`,
  `callbackIdentity`, `portalOrphans`, `leakSuspected`, `churnDegradation`,
  `superlinearGrowth`, `budgetBreach`, `domFlat`, `measuredState` (M40).
- `hintsForReport(report)` derives the set from the report alone. A hint is
  documentation attached to a diagnosis, never advice generated from inspecting
  code the tool did not measure.
- Each class appears once per run however many combos triggered it, in a stable
  order so terminal output does not reshuffle between runs.
- Hints MUST NOT change verdicts.
- Every output mode ends with them (`appendHints`), after the findings they
  refer to. `Report.hints` carries ids, never prose, so wording can change
  without schema churn.
- `MEASUREMENT_BASIS_LINE` appears in every report header: 4× CPU throttle,
  budgets calibrated for those conditions, numbers comparative rather than
  production wall-clock.
- README gains a "which mode answers my question" decision table and one
  remediation section per hint anchor; `--help` gains the compressed mode table.

## Design

The draft asked for `hintId` per finding. Run-level `Report.hints` is what
ships: it satisfies the actual requirement (ids not prose, so hints reword
freely) without threading an id field through every finding interface, and the
terminal prints per run anyway.

The copy criterion from the draft's open questions is enforced by test rather
than by review discipline: every hint body must match an imperative verb, and
must not contain the vague-advice phrasings ("consider memoization", "think
about", "you may want to") that make hints restate the finding. A further test
resolves every anchor against the README's actual headings, so a reworded
section cannot silently orphan a hint.

## Hardening

| # | Hypothesis | Result |
|---|---|---|
| H1 | A clean report emits hints anyway | Pass — empty |
| H2 | A class repeats once per combo that triggered it | Pass — once per run |
| H3 | Hint order follows discovery and reshuffles | Pass — stable |
| H4 | Linear growth is treated as superlinear | Pass — quadratic/exponential only |
| H5 | An anchor points at a heading that does not exist | Pass — all resolve |
| H6 | Hints restate the finding instead of naming an action | Pass — imperative required, vague phrasings rejected |

## Deferred

- Cost-attribution package hints ("Chart.js is 60% of mount" → lazy-load
  guidance). Package-level advice is situational enough that a template would
  more often mislead than help.
- A copy review round against real findings from the dogfooding repos. The
  automated criteria above are a floor, not a substitute.
