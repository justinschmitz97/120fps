---
kind: milestone
status: implemented
tests:
  - test/unit/m66-attribution-window.test.ts
  - test/unit/m66-callback-identity.test.ts
  - test/unit/m66-harden.test.ts
  - test/e2e/m66-callback-identity.test.ts
  - test/e2e/m66-attribution-window.test.ts
  - test/e2e/m66-harden.test.ts
---

# M66 — attribution honesty

## Purpose

Two numbers the report prints are not what their label says.

1. **Cost breakdown vs the Mount column.** The breakdown sums scripting across
   *every* measured mount; the Mount column shows the *median of one* mount. The
   two sit on the same screen and cannot be related: kaninchen `Kbd` combo0 read
   `Mount 5.08ms` beside a breakdown totalling `26.85ms` (5.28x). The multiplier
   is `sampleCount x scripting-share-of-a-mount` — 10 x 0.529 for that combo —
   which is why it shrank as the component grew and paint took a larger share.

2. **Callback identity.** `dispatch` was reported as an unstable callback in two
   projects (+6.6ms, +27.6ms), which React's referential-stability guarantee
   makes impossible. The measurement compares two arms that receive the same
   treatment, so every number it produces is drift.

## Contract

### 1 — attribution covers one mount

- `attributeCost` MUST accept either a single trace window (`TraceEvent[]`) or
  the per-sample windows of one combo (`TraceEvent[][]`).
- Given N windows, the returned `buckets[].durationMs` MUST be the **mean
  scripting time inside one mount**, not the sum across the N mounts.
- `CostAttribution` MUST carry `sampleCount` (windows folded in) and
  `totalScriptingMs` (the pre-division sum), so a reader can recover the raw
  number and the window it covers from the JSON alone.
- Invariant: `sum(buckets) === totalScriptingMs / sampleCount`.
- Invariant: `sum(buckets) <= mean(per-window top-level duration)`. Each window's
  script-event net durations nest inside that window's top-level events, so the
  breakdown can never exceed the mount it describes. With the per-sample mean
  this bounds the breakdown by the Mount column's own scale.
- `percentage` MUST stay a share of the buckets' own total, unchanged by
  normalization.
- MUST NOT change bucket naming, the react/package/user/browser taxonomy, the
  Vite URL munging, or the nesting-stack dedupe.

### 2 — callback identity measures identity

- The probe MUST mount with the same cached callbacks the stable arm re-renders
  with. Mounting with a different function makes both arms change callback
  identity between mount and re-render, which is the defect: the arms then do
  identical work and the reported delta is whatever drift separated them.
- Every function-valued prop MUST be a real function in both arms. Only the
  measured prop may differ between them, and it MUST be present in the mount so
  the stable arm changes nothing at all.
- The two arms MUST be interleaved (`s` even: stable then fresh; `s` odd: fresh
  then stable) rather than measured as all-stable-then-all-fresh.
- A delta MUST be reported only when it clears the machine's own scatter:
  `delta > max(0.5ms, spread(stable) + spread(fresh))`, where `spread` is
  `max - min` of that arm's samples. Fewer than 2 samples in either arm gives no
  noise estimate and MUST report nothing.
- `CallbackIdentityDelta` MUST carry the two medians (`stableMs`, `freshMs`)
  behind the delta.
- Invariant: a function React keeps referentially stable (a `useReducer`
  dispatch, a `useState` setter, a `useRef`-held callback) reaches the memoized
  child unchanged on every render, so it MUST NOT produce a finding. A prop the
  component forwards to a memoized child MUST still produce one when the caller
  recreates it per render.

## Design

**Windows, not events.** `mountTraces` is already one entry per recorded sample
(`measure.ts:1371-1393`, warmups excluded). Flattening it discarded the only
boundary that made the sum interpretable. Accepting the nested shape restores it
without a second capture, and the flat overload keeps the single-window meaning
for callers that hold one trace.

Per-sample mean over median-sample scoping: scoping to the median window would
make `sum(buckets) <= Mount median` exact, at the price of throwing away 90% of
the captured scripting and letting the bucket *ranking* — the thing M16 exists
to produce — flip between runs on one sample's noise. The mean keeps every
sample in the ranking and stays bounded by the mount it describes.

**The stable arm was never stable.** `mountAndWaitProbe` converts each function
prop marker into a freshly allocated `() => {}` inside the page
(`react-profiler.ts:501-516`), while the stable arm re-renders with a cached
function from `stableCallbackCache`. Mount and re-render therefore carried
different function identities in *both* arms, every memoized child re-rendered in
both, and the difference between them was pure measurement drift. An A/A control
(both arms re-rendering with the stable callback) on a 900-node memoized fixture
reported +18.1ms unsplit and +30.9ms interleaved — the same magnitude as the
production false positives.

**A free noise floor.** Each arm's own sample spread is the machine's scatter at
that workload, so no third control arm is needed. The A/A runs above are rejected
by it (18.1 < 29.8+34.8; 30.9 < 19.3+32.3) while a real identity effect — a
memoized subtree bailing out versus re-rendering — clears it by an order of
magnitude.

## Deferred

- The two attribution call sites still flatten: `analyze.ts:405-407`
  (`const allEvents = mount.mountTraces.flat(); combo.costAttribution =
  attributeCost(allEvents);` → `combo.costAttribution =
  attributeCost(mount.mountTraces);`) and `report.ts:1064`
  (`attributeCost(mount.mountTraces.flat())` →
  `attributeCost(mount.mountTraces)`). Both files are owned by a concurrent
  milestone. Until they land, `sampleCount` stays 1 and the printed breakdown
  keeps summing across samples.
- `report.ts` prints buckets without naming the window. With the call sites
  patched the numbers are per-mount and need no caveat; a `(mean of N mounts)`
  suffix would still read better.
- Prop-type knowledge would let the tool skip the probe entirely for a prop typed
  `Dispatch<A>` or `Dispatch<SetStateAction<S>>`, which React guarantees stable
  at every call site. That lives in `prop-gen.ts` and is a separate slice.
- Attribution of interaction traces (open since M16) is untouched.
