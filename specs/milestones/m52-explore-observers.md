---
kind: milestone
status: closed — premise falsified by measurement; observers ship as opt-in
tests:
  - test/e2e/m52-observers.test.ts
  - test/unit/m52-observed-cost.test.ts
---

# M52 — explore-phase observer rework

## Purpose (as stated)

Explore dominates measured-path wall clock. The milestone assumed the cost
driver was the per-exercise CDP trace lifecycle — start/stop/collect per
interaction sample — and proposed replacing it with in-page observers.

## Outcome: the premise was wrong

The acceptance measurement was run before switching anything, and it falsifies
the hypothesis. Removing per-sample tracing entirely does not approach the ≤50%
target.

### Interleaved A/B, 3 rounds per component, same window

| component | trace path | observer path | ratio |
|---|---|---|---|
| counter.tsx | 67066ms | 65525ms | 0.98 |
| aria-tabs.tsx | 3773ms | 3675ms | 0.97 |
| aria-listbox.tsx | 4776ms | 4023ms | 0.84 |

Mean ratio **0.93** against a target of ≤0.50. Coverage was identical on every
component — the same edges, the same patterns — so the comparison is like for
like and the invariants held. The observer path is simply not where the time
was.

### Where the time actually goes

Measured directly on `counter.tsx` (rapid-toggle-11, 11 steps, 4× throttle):

| phase | per sample | share |
|---|---|---|
| remount + fence (`navigateToState`) | 34ms | 4% |
| executing the stress pattern | 747ms | **91%** |
| CDP tracing | 36ms | 4% |

At ~68ms per step, the cost is the per-step settle under vsync pacing — a
double-rAF fence (~33ms at 60Hz) plus Playwright's click actionability checks
and React's render under throttle — repeated once per event. Tracing was never
the driver, and neither was remount-and-replay, which the draft named as the
second-order lever.

### The values, measured after the wall clock

The A/B above compared wall clock and coverage. It did not compare the numbers
the two paths produce, so that was measured too — interleaved, same window,
`samples: 5`, one combo.

| component | trace ms/step | observer ms/step | edges |
|---|---|---|---|
| aria-tabs.tsx | 0.79–0.98 | **0.00** | 3/3 |
| aria-listbox.tsx | 0.51–0.57 | **0.00** | 4/4 |

Every edge of both components reads zero. Event Timing's `durationThreshold`
minimum is 16ms per event, an order of magnitude above what a real component
costs per step, so a fast interaction is not measured as cheap — it is not
observable at all. Probing one component's windows directly shows the failure
mode is bimodal rather than merely coarse: the same 6-step keyboard sweep read
16.00ms on one window and 0.00ms on the next two, and a median over samples
collapses that to 0.

The opposite direction fails as well. Chromium emits one entry per dispatch
target, so 11 clicks on `m52-slow-click.tsx` arrive as **62 entries** — each
click's pointerdown/pointerup/click trio plus one pointerenter per ancestor,
all ending at the same presentation. Summing them reads 2720ms for a 1.5s
window. A window's *total* interaction cost is therefore not recoverable from
Event Timing; only its slowest interaction is. Since `perStepCost` divides an
edge's median by its step count, and the tier budgets compare against that,
there is no observer aggregate that reproduces the metric.

## Decision

**Do not switch over.** Two independent reasons, either sufficient:

1. The metric does not survive the switch. Explore would report 0.00ms/step for
   the components the tool is pointed at, taking interaction ranking,
   per-interaction scaling curves and baseline regression comparison with it.
   Verdicts alone would survive, because the smallest per-step budget (33ms)
   sits above the 16ms floor — a tool that only ever answers "pass" is not the
   trade either.
2. The wall clock does not pay for it. The switch bumps `METRICS_REVISION`,
   classifying every stored baseline `incompatible` for every user, and the
   acceptance criterion (≤0.50) is missed at a measured 0.93.

`src/observers.ts` ships as **opt-in acquisition** (`ExploreOptions.observerTiming`),
because it is verified, coverage-identical, and gives metrics the trace path
cannot: presentation-inclusive event duration, input delay separated from
processing time, and LoAF script attribution at interaction level. Nothing
depends on it by default.

## What ships

- `installObservers` / `beginObservedWindow` / `readObservedWindow` /
  `observedInteractionMs` — Event Timing, Long Animation Frames and
  layout-instability, scoped to a window by start time rather than by clearing
  buffers, so a late entry cannot be attributed to the next window.
- `observedInteractionMs` is the window's **slowest** interaction, not a total,
  for the 62-entries-per-11-clicks reason above. `ObservedEvent.interactionId`
  carries Chromium's grouping so a caller can see which entries belong to one
  interaction; 0 means the entry belongs to none.
- `readObservedWindow` yields until a turn passes with no new entry (bounded at
  three). An observer callback is queued after its frame presents, so a read
  taken on the caller's own double-rAF fence dropped the entry it was opened
  for.
- An unsupported entry type degrades to absence, never to a zero:
  `eventTimingUnavailable` distinguishes "nothing was slow" from "nothing was
  observable".
- `ExploreOptions.observerTiming` selects the timing source; the default is the
  trace path and stays there. Coverage is identical either way — same combo
  selection, discovery, patterns, sample counts, state-graph semantics.

## Metric mapping (kept for whoever revisits this)

| current CDP metric | observer equivalent | fidelity |
|---|---|---|
| interaction duration (trace span) | Event Timing `duration` | **improves** — presentation-inclusive |
| input latency | `processingStart - startTime` | 1:1, newly separable |
| processing time | `processingEnd - processingStart` | new |
| long tasks | `long-animation-frame` + `blockingDuration` | 1:1 in intent, frame-scoped |
| layout shift score | `layout-shift` entries | 1:1 |
| script attribution | LoAF `scripts[].sourceURL` | new at interaction level |
| style-recalc **count** | none | **degrades** |
| paint **count** | none | **degrades** |

## Answered open question: the Event Timing floor

Verified in the harness's own Chromium. The observer requests
`durationThreshold: 16` (the API's documented minimum, not the 104ms default)
and every reported entry lands at or above it; nothing below is observable.
Acceptable for stress patterns by construction — M33's budgets are per-event
frame budgets — with `observedInteractionMs` falling back to LoAF blocking time
below the floor.

## Hardening

| # | Hypothesis | Result |
|---|---|---|
| H1 | Entries leak between measured windows | Pass — filtered by start time |
| H2 | An idle window reads as unobservable | Pass — quiet and unsupported differ |
| H3 | Re-installing double-counts an interaction | Pass — guarded |
| H4 | An unsupported entry type zero-fills | Pass — degrades to absence |
| H5 | The 16ms floor is assumed rather than measured | Pass — verified |
| H6 | Observer timing changes what explore covers | Pass — identical edges on 3 components |
| H7 | The read drops the entry its window was opened for | **Failed** — fixed by yielding until quiet; test reads on the fence alone |
| H8 | Entries of one dispatch accumulate into the cost | Pass — maximum, not sum; pinned against the measured 62-entry window |
| H9 | The default timing source drifts to observers | Pass — explore's edges carry a trace per sample |

## Where the next lever is

Not here. On the evidence above, explore's wall clock is the per-step settle,
so a future milestone should target that: fewer fenced steps per pattern, a
cheaper settle than a double rAF at vsync, or driving frames during explore —
the last of which collides with M35's boundary (explore's metrics depend on
real frame scheduling) and would need its own justification.
