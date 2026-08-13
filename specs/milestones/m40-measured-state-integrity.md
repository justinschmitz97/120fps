---
kind: milestone
status: implemented
tests:
  - test/unit/m40-measured-state.test.ts
  - test/e2e/m40-measured-state.test.ts
  - test/e2e/m40-harden.test.ts
---

# M40 — measured-state integrity (loading-state disclosure)

## Purpose

A component that fetches on mount, suspends, or defers work renders a
skeleton/fallback first — and the mount measurement captures that transient
state without saying so. The report presents "mount 6ms, 4 DOM nodes" as if it
described the component; it describes the spinner. This is a
silent-wrong-answer class: worse than a failed run, because nothing tells the
user the numbers are about the wrong scene. Connected components are exactly
the ones most worth profiling, so this is the first wall a design-system or
product team hits.

## Contract

- Every measured combo carries a settledness classification:
  `ComboReport.measuredState: "settled" | "pending-network" | "late-mutation"`.
  - `pending-network`: a fetch/XHR request initiated during mount was still in
    flight when the grace window closed.
  - `late-mutation`: the component DOM (component-node scope, M31) mutated
    after the mount fence without any input.
  - `settled`: neither signal fired.
- Both signals fire → `pending-network`. It names a cause the mutation signal
  only hints at.
- A non-`settled` combo appends a run-level warning naming the combo and the
  signal (`MEASURED_STATE_WARNING`). Warn, never fail — the skeleton's mount
  cost is a real number; the defect would be presenting it as the whole story.
- Detection MUST NOT alter measured values: probes run between traced windows,
  on the first sample of a combo only (per-combo fact, M34 precedent for
  `domNodeCount`/`hasAnimation`).
- Combos flagged `hasAnimation` MUST NOT be reported `late-mutation`:
  animation mutates the DOM by design. They still report `pending-network`.
- Baseline comparison skips regression analysis when baseline and current
  entries recorded different `measuredState` values
  (`BaselineComparison.measuredStateMismatch`), and warns. Comparing a skeleton
  to settled content is not a regression signal. A baseline without a recorded
  state (pre-M40) compares normally: an unknown state is not a changed state.
- Fingerprint reuse (M39) stores `measuredState` in the baseline entry, and a
  reused verdict repeats the disclosure.

## Design

- **Network signal**: `installMeasuredStateProbe` wraps the page's `fetch` and
  `XMLHttpRequest.prototype.send` once per page, in `enterHarness`, before
  anything mounts. Each request gets a monotonic id, held in a pending set
  until its promise settles (`loadend` for XHR).
  - Not CDP's `Network` domain: its event traffic lands inside traced windows,
    and enabling it for the probing sample only would make that sample's
    conditions differ from the rest of the median. The wrapper is installed for
    every sample equally and read outside traced windows.
  - `pending` is compared against the `started` watermark read before the mount,
    so a request left hanging by an earlier combo does not flag the next one.
  - `fetch` settles at response headers. A component still awaiting `.json()`
    reads as settled on this signal; the mutation signal covers that tail.
- **Mutation signal**: `beginMutationWatch` installs a `MutationObserver` over
  the component-node scope (`#root` subtree, portal children of `document.body`,
  plus `document.body` itself at `childList` so a late portal is caught) the
  moment the fence clears; `endMutationWatch` holds `MEASURED_STATE_HOLD_MS` of
  real time, then disconnects. `probeLateMutation` composes the two for callers
  with nothing to do in between. Timers run on wall
  clock under the M35 frame pump, and the pump keeps driving frames throughout,
  so rAF-scheduled updates land.
  - The hold runs for animated combos too, with observation off: the network
    signal reads after the same grace window either way.
- **Grace window**: `MEASURED_STATE_HOLD_MS = 120`. Long enough for a
  promise-resolution or short-timer re-render to land, short enough that every
  combo can pay it once. A single passive effect setting state resolves inside
  the mount fence and never reaches the hold (hardening H1).
- Suspense: a suspended tree usually manifests as both signals (fallback DOM +
  pending promise). A direct fiber-level signal via the M18 profiler hook is a
  candidate refinement, not required.

## Hardening

| # | Hypothesis | Result |
|---|---|---|
| H1 | One `useEffect` setState reads as a late mutation | Pass — settles inside the fence |
| H2 | An animated component is blamed for its own mutation | Pass — reports settled |
| H2b | The animation is not detected in the first place | Pass — detected |
| H3 | A request from an earlier combo flags the next | Pass — id watermark scopes it |
| H4 | An aborted request stays pending forever | Pass — clears |
| H5 | A rejected fetch stays pending forever | Pass — clears |
| H6 | A pending XHR is invisible | Pass — counted |
| H7 | A completed XHR stays pending | Pass — clears on `loadend` |
| H8 | Re-installing the probe double-counts requests | Pass — guarded, idempotent |
| H9 | A component that renders nothing throws in the probe | Pass — clean |
| H10 | A late portal outside `#root` is missed | Pass — caught |
| H11 | The hold does not span the grace window | Pass — spans it |
| H12 | A settled component picks up a neighbour's state | Pass — settled, no warning |
| H13 | `send()` on an unopened XHR leaks a pending id | Fixed — settle on synchronous throw |
| H14 | A synchronous XHR fires `loadend` before the listener attaches | Fixed — listener attaches before `send` |

## Known limitation: the observation window's offset

The mutation watch is armed as early as possible — immediately after the mount
fence, **before** `countComponentNodes` and `detectAnimations`, so content
arriving while those probes run is still attributed to the component rather than
lost to our own instrumentation.

It cannot be armed earlier than that. Arming inside the traced window would add
cost to the measurement, which the contract forbids, and trace collection itself
takes a variable few hundred milliseconds. The window therefore opens at an
offset that moves with machine load, and a component that mutates once, briefly,
inside that offset is reported `settled`.

**False negatives are possible; false positives are not.** A reported
`late-mutation` always corresponds to an observed mutation. The network signal
partly covers the same class independently: a request still in flight is caught
regardless of when the window opened.

This is why the pipeline-level test asserts the invariant that always holds —
one disclosure per non-settled combo, naming that combo and its signal — rather
than a specific classification for a specific fixture. The probe's own
reliability is covered deterministically at the probe level.

## Deferred

- `--settle` mode: wait for network idle + DOM quiescence, then measure a
  settled-state number as a second data point per combo. M41's request mocking
  may make it unnecessary.
- Distinguishing "resolved during the grace window, DOM updated" from "still
  pending at grace end" — the former already surfaces as `late-mutation`.
- Explore on a non-settled combo explores the skeleton. Whether explore should
  skip or delay those combos belongs with M52.
