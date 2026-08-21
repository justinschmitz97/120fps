---
kind: milestone
status: draft
tests:
  - test/unit/frame-starvation-retry.test.ts
  - test/unit/delta-phase-stall-hint.test.ts
---

# M89: Prop-delta measurement completes

## Purpose

taxonomy's `button.tsx` reaches the prop-delta pass and dies:
`rerender phase failed on combo 14 of button.tsx: page.evaluate: Error: frame starvation: rAF fence
exceeded 10000ms`. `--no-deltas` produces a clean `Result: PASS` in 4m 8s, isolating the fault to the
delta pass alone. The delta pass (`measureStandardPropDeltas`, `src/analyze.ts`) measures combos the
main combo/scale passes did not already cover by calling `measureMount`/`measureRerender`
(`src/measure.ts`) again, opening a fresh measurement session per call. `rafFence` — the double-`
requestAnimationFrame` fence every mount and rerender waits on — has no retry today: one 10-second
timeout and the whole pass throws, uncaught until it reaches the CLI's top-level handler.

No reproduction of the frame pump itself failing to produce frames was available in this environment
(no access to the corpus repository), so the root cause of *why* the fence starves specifically on a
delta-pass-opened session is not established here. What is established and fixed: the fence had no
retry and no degradation path, so any transient starvation — whatever triggers it — took down the
entire run instead of the one measurement it affected.

A second live run on the same corpus repository, after the frame-starvation fix, surfaced two more
signatures reaching the same unguarded edge: `Tracing.tracingComplete timed out` and a closed browser
target (`Target crashed` / `Target page, context or browser has been closed`), the latter observed as
`rerender phase failed on combo 1 of button.tsx: browserContext.newCDPSession: Target page, context or
browser has been closed` — a closed target reached *while re-entering the harness to recover from a
different, unrelated stall*, not from the traced sample itself. Both are recoverable the same way frame
starvation is (re-entering the harness against a fresh CDP session), so the retry now covers all three.
The same run also showed the resulting error still carrying `retry with --no-attribution, ...` for a
`rerender`-phase failure — `--no-attribution` disables `react-profiler.ts`'s cost-attribution pass only,
which `measureRerender` never runs, so the hint named a flag that changes nothing for this failure
(confirmed by a verifier A/B test against the exact failure).

## Contract

### MUST

- A component measurable with `--no-deltas` also completes its delta pass, or the delta pass degrades
  to a disclosed partial result rather than failing the run.
- The rAF fence has a bounded, disclosed retry and does not exceed the phase budget silently.
- A `Tracing.tracingComplete timed out` or closed/crashed browser target failure (`Target crashed` /
  `Target page, context or browser has been closed`) reaching `measureMount`/`measureRerender`'s
  sample loops gets the same bounded, disclosed retry-then-degrade treatment as frame starvation,
  sharing the same retry budget — not just frame starvation.
- Any remediation hint for a phase failure names a flag that actually targets the failing phase: a
  `rerender`-phase stall names `--samples`/`--max-combos`, not `--no-attribution`.

### MUST NOT

- Suggest `--no-attribution` for a failure in the delta phase or the rerender phase.
- Retry a stall signature the retry cannot classify (anything outside frame starvation, tracing
  timeout, and target-closed/crashed): those propagate unchanged, same as before this milestone.

### Invariants

- A frame-starvation, tracing-timeout, or target-closed/crashed failure on one combo never aborts
  measurement of the remaining combos in the same pass: `measureMount`/`measureRerender` return a
  result for every combo that did not stall out, omitting only the ones that exhausted their retry
  budget.
- The retry bound (`MAX_FRAME_STARVATION_RETRIES`) is scoped per combo, not per pass or per run:
  `withFrameStarvationRetry`'s `attempt` counter is a fresh local on every call, so one combo
  exhausting its retries and degrading has no effect on the next combo's own budget — the Nth starving
  combo in a pass degrades exactly like the first. A pass where every combo starves still returns
  (an empty-slot result for each) rather than hanging or failing after the first exhaustion, bounding
  total retry work at `combos.length * (MAX_FRAME_STARVATION_RETRIES + 1)` attempts per guarded step.
- The guard covers a combo's warmup step (`withWarmupRetry`, composing the identical
  `withFrameStarvationRetry`-around-`withContextRetry` pattern) as well as its sample loop: a stall
  during warmup degrades and omits the combo the same way a stall during sampling does, rather than
  escaping unguarded. Both steps share one pass-scoped `retryBudget` (`withContextRetry`'s own budget,
  for the tracing-timeout/target-closed overlap) and one `enter()`, but `withFrameStarvationRetry`'s
  per-combo bound around each step is independent of that shared budget's state.
- A combo omitted this way is disclosed by name (its index) and reason (which of the three signatures),
  not merely absent with no trace, and the disclosure text never misnames the signature (a closed
  target is never described as "frame starvation").
- Every other failure category `measureMount`/`measureRerender` already handle (context loss from
  signatures outside these three, page errors) is unaffected: this milestone's retry path composes
  around `withContextRetry`, it does not change how `withContextRetry`'s own signature list is retried
  or escalated.
- No shutdown/abort signal is observable anywhere in this codebase (no `SIGINT`/`SIGTERM` handler, no
  `AbortController` threaded through measurement); a target closed by a genuine process teardown is
  bounded by the same small fixed retry budget as any other target-closed failure, costing at most two
  quick, already-failing attempts rather than hanging or looping.

## Design

**Bounded retry, not indefinite, across three stall signatures** (`src/measure.ts`).
`isFrameStarvationError` matches the fence's own `/frame starvation/i` message; `isTracingTimeoutError`
and `isTargetClosedError` match the same two signatures `page-errors.ts`'s `STALL_SIGNATURES` and this
file's own `CONTEXT_LOST` list already carry (`/Tracing\.tracingComplete timed out/i`,
`/Target (page|closed|crashed)/i`). `withFrameStarvationRetry` wraps a per-combo measurement body: on
any of the three it re-enters the harness session (the same `enter()` — `refreshCdpSession` +
`enterHarness` — the existing context-lost retry already uses, which replaces the CDP session the
frame pump reads on every loop iteration) and retries, up to a small fixed bound
(`MAX_FRAME_STARVATION_RETRIES`) shared across all three signatures and across both the direct `body()`
call and a stall inside `enter()` itself while recovering. This is a separate, orthogonal layer from
`withContextRetry` (which handles a disjoint — but overlapping, for tracing-timeout and target-closed —
failure signature list on its own per-pass budget, and keeps its own escalate-and-throw behavior
unchanged) — composed around it, not merged into it. `Tracing.tracingComplete timed out` and
`Target crashed`/`Target ... closed` are matched by `withContextRetry`'s `isContextLostError` too, so
the ordinary path is unchanged: `withContextRetry`'s own single-shot retry recovers most occurrences,
exactly as before this milestone. `withFrameStarvationRetry`'s guard is what catches what already
escaped that inner retry — the retried body failing again, or (the live-proof shape)
`refreshCdpSession`'s `newCDPSession` call inside `enter()` itself throwing because the target is
already gone. No shutdown/abort signal is observable anywhere in this codebase to distinguish a
teardown-caused close from a transient one, so the existing small fixed budget is the only guard: a
genuine teardown costs at most two quick, already-failing attempts, not a loop. Disclosure text is
signature-specific and never crosses wording: `frameStarvationRetryWarning`/
`frameStarvationDegradedWarning` name "frame starvation", `tracingTimeoutRetryWarning`/
`tracingTimeoutDegradedWarning` name "tracing timeout", `targetClosedRetryWarning`/
`targetClosedDegradedWarning` name "target closed".

**Every guarded step is scoped to its own combo.** `withFrameStarvationRetry`'s bound lives entirely in
a `let attempt = 0` local to each call — nothing persists it across combos or across the driven/vsync
partition of a pass — so combo N exhausting its retries and degrading leaves combo N+1's own call with
a full, untouched budget. `measureRerender` and `measureMount` each call it (directly, or via
`withWarmupRetry`) at every point in the per-combo loop where a stall-classified error could occur, not
only the sample loop: the warmup step run before sampling (`mountAndWait` + `rerenderAndTrace` in
`measureRerender`; `runMountUnmount` in `measureMount`) is wrapped by `withWarmupRetry`, which composes
the identical `withFrameStarvationRetry`-around-`withContextRetry(enter, warmup, { budget: retryBudget
})` pattern the sample loop uses, returning `boolean` (not `T | undefined`, since a warmup body resolves
to `void` and would otherwise be indistinguishable from a degraded outcome) so the caller can `continue`
to the next combo — draining and discarding that combo's `errorCapture` window first, so a page error
seen only during a degraded warmup does not leak into the next combo's drained result — when warmup
never completes. Before this, the warmup step ran unwrapped: a stall there bypassed retry/degrade
entirely and propagated as a raw error out of the pass, indistinguishable at the top level from any
other uncaught failure and carrying none of `withFrameStarvationRetry`'s disclosure (no
"retrying against a freshly re-entered harness session" warning preceded it) — the live-proof shape of
one combo degrading correctly through its sample loop while the very next combo, starving during
warmup instead, still failed the whole run.

**Exhaustion degrades, it does not fail the run.** When the bound is exhausted, `measureRerender`'s and
`measureMount`'s per-combo loops disclose (`onWarning`, the same channel `CONTEXT_RETRY_WARNING` and
`FRAME_PUMP_WARNING` already use) and leave that combo's slot in the results array unset, rather than
propagating the error out of the pass. `RerenderResult[]`/`MountResult[]` returned this way can be
shorter than the input `combos[]` for the entries that stalled out (frame starvation, tracing timeout,
or a closed target); every existing consumer already looks these arrays up by `comboIndex` via
`.find(...)` with optional chaining (`buildReport`, `measureStandardPropDeltas`), not by positional
index, for exactly this reason — a combo a budget or explore-time cap already could not reach is an
existing, already-handled shape. Curve-mode's `buildCurveReport` is the one consumer that indexes
positionally (`input.rerenders[i]` against `scalePoints[i]`); it already reads through
`rerender?.stable.samples ?? [0]`, tolerating a hole at a given position without shifting subsequent
ones — the fix preserves this by leaving the failed index's array slot empty rather than filtering the
array, so no position downstream of a stalled combo moves.

**Phase-aware hint text** (`src/page-errors.ts`). `createPhaseTracker`'s `enrichPhaseError` (invoked
from `src/measure.ts`) selects a hint by `MeasurementPhase` via `stallHintForPhase`: `"delta"` gets
`DELTA_PHASE_STALL_HINT` (names `--no-deltas`), `"rerender"` gets `RERENDER_PHASE_STALL_HINT` (names
`--samples`/`--max-combos`; leaves out `--explore-budget` for the same reason it leaves out
`--no-attribution` — neither touches `measureRerender`'s own workload), and every other phase
(`"mount"`, `"explore"`, `"attribution"`) keeps `HARNESS_STALL_HINT` (names `--no-attribution`) —
`"attribution"` (`react-profiler.ts`) is the one phase `--no-attribution` genuinely disables something
for. `retagPhaseError` re-runs this same selection against the preserved `.cause` when a caller's own
context is more specific than the phase an inner call already tagged (the delta pass's own extra
mount/rerender calls, tagged `"mount"`/`"rerender"` by `measure.ts` before the delta pass's catch ever
sees them) — a `"rerender"`-tagged error retagged to `"delta"` always ends up with
`DELTA_PHASE_STALL_HINT`, never `RERENDER_PHASE_STALL_HINT` leaking through. `"mount"` and `"explore"`
keep `--no-attribution` unexamined by this milestone; see `## open`.

## Open questions

`"mount"` and `"explore"` phase stalls still surface `HARNESS_STALL_HINT` (`--no-attribution`), which is
no more true a remediation for those two phases than it was for `"delta"` or `"rerender"` —
`--no-attribution` disables only the `"attribution"` phase's own pass. Not fixed here: no live proof
(taxonomy or otherwise) has yet surfaced a `"mount"`- or `"explore"`-phase stall reaching this hint the
way the delta and rerender phases did, so the correct replacement flags are not yet evidenced from a
real run. Recorded as a known gap in the same governing rule
(`specs/milestones/m92-every-printed-message-is-true.md`) rather than guessed at here.

## Verification

- A regression test (`test/unit/frame-starvation-retry.test.ts`) exercising
  `withFrameStarvationRetry`/the retry-then-degrade path directly (a fake `body` that throws each of the
  three stall signatures — frame starvation, `Tracing.tracingComplete timed out`, and a closed/crashed
  target — a controlled number of times) asserts, per signature: fewer than the retry bound → recovers
  and returns a result; at or beyond the bound → the combo is omitted (returns `undefined`) and a
  warning naming the combo index and that signature's own wording is emitted (never another
  signature's wording, e.g. a closed target is never disclosed as "frame starvation"); no error escapes
  the function. A mixed-signature sequence (e.g. starvation then target-closed across successive
  attempts, or a different signature thrown from `enter()` than from `body()`) still recovers within
  the shared budget. A non-stall error (matching none of the three) thrown from the same body still
  propagates unchanged and triggers no retry (negative case: this milestone's retry path is not a
  general catch-all).
- `withWarmupRetry` gets the same direct, browser-free treatment: a warmup body that recovers within
  the bound returns `true` with a retry warning; one that exhausts the bound returns `false` (never
  throws) with the signature-specific degraded warning, for each of the three signatures; a non-stall
  warmup error propagates unchanged; an already-exhausted shared `retryBudget` still degrades rather
  than escaping, since `withFrameStarvationRetry`'s own per-call bound is independent of it.
- A multi-combo simulation (mirroring `measureRerender`/`measureMount`'s actual warmup-then-sample
  composition, one shared `enter()` and `retryBudget` across combos) proves the per-combo scoping
  invariant directly: two consecutive combos starving — one during warmup, one during sampling — both
  degrade and are both disclosed, and the run's result array reports rather than throwing; every combo
  in an 8-combo run starving still returns a full result array (every slot omitted) with a disclosure
  per combo, rather than hanging or failing after the first exhaustion; a non-stall error still
  propagates unchanged and aborts the run (negative case).
- `isFrameStarvationError`, `isTracingTimeoutError`, and `isTargetClosedError` each get boundary tests:
  match their own signature's exact and wrapped/re-thrown message forms (including the live-proof
  shape, a phase-prefixed message with the CDP method name inline), do not match an unrelated error or
  another signature's message, do not match a non-`Error` thrown value.
- `test/unit/delta-phase-stall-hint.test.ts` and `test/unit/render-health.test.ts`'s `C4 enrichPhaseError`
  suite assert `stallHintForPhase`'s selection directly: `"delta"` always names `--no-deltas` and never
  `--no-attribution`; `"rerender"` always names `--samples`/`--max-combos` and never `--no-attribution`
  or `--no-deltas`; `"mount"`, `"explore"`, and `"attribution"` keep naming `--no-attribution`; a
  non-stall error gets no hint regardless of phase; `retagPhaseError` moving a `"mount"`- or
  `"rerender"`-tagged error to `"delta"` context always lands on `DELTA_PHASE_STALL_HINT`, never a
  leaked `RERENDER_PHASE_STALL_HINT` or `HARNESS_STALL_HINT`.
- No existing test in this codebase mocks a full Playwright browser session to unit-test
  `measureRerender`/`measureMount` end to end (confirmed by search: `createBrowserPool`'s injectable
  `launcher` is unused by any current unit test); building that harness for this milestone alone was
  judged out of proportion to the fix and not attempted, consistent with the project's existing
  unit/e2e boundary (browser-driving functions are exercised by e2e, explicitly out of scope for this
  lane). The retry integration into `measureRerender`'s and `measureMount`'s sample loops and warmup
  steps is verified by: `tsc --noEmit` passing with both restructured around `withFrameStarvationRetry`
  / `withWarmupRetry`; the full existing `measure`/`rerender`/`frame-pump` unit suites passing unchanged
  (no regression to the surrounding logic the loops share); and direct code inspection confirming each
  loop composes `withFrameStarvationRetry` (directly, or via `withWarmupRetry` for the warmup step)
  around the exact same `withContextRetry`-wrapped body it called before, changing only how an
  exhausted-retry stall failure (any of the three signatures, at either point in the per-combo loop) is
  handled.
