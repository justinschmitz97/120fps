---
kind: milestone
status: approved
tests: test/unit/m33-frame-budgets.test.ts, test/unit/m30-interaction-steps.test.ts, test/unit/m30-context-retry.test.ts
---

# M33 — frame-derived interaction budgets

## Purpose

M30 made interaction budgets per step and derived the per-step value by dividing the old aggregate by 11, the step count of `rapid-toggle-11`. That preserved the previous calibration rather than justifying it, and it counted steps wrong for the one pattern whose steps are not events. Both are fixed here against 39 interaction measurements taken from `justinschmitz.de`, `trnscrpt`, `focusrings` and `color-generator`.

## Non-goals

- Changing mount or rerender budgets. Only the interaction axis is re-derived.
- Per-pattern budgets. Once the unit is one event, one budget per tier is enough.

## Contracts

### E1 — the unit is one event, not one step

`InteractionReport.steps` was `StressPattern.steps.length` (M30 F5). Every pattern enumerates one step per event except `pointer-drag`, which is a single step carrying `moveCount: 60` (`src/stress-patterns.ts:116-121`).

- `countPatternEvents(pattern)` MUST sum `moveCount ?? 1` over the steps.
- `rapid-toggle-11` → 11, `open-close-10` → 20, `multi-keystroke` → 11, `single-shot` → 1, `pointer-drag` → 60.
- Explorer MUST record that count, so a drag is compared as 60 events rather than one.
- Consequence, measured: drag costs move from 32-113ms "per step" to 6-21ms per event, which is the same range as a click and makes one budget meaningful across patterns.

### E2 — the budget is a frame

- `TierBudget` gains `interactionStepMs`, the cost allowed for one event.
- Derived, not chosen: a frame at the tool's namesake 120fps is 8.33ms, and measurements run under 4x CPU throttle, so one 120fps frame of work is 33ms of throttled time. One 60fps frame is 67ms.
- `T1: 33` (one 120fps frame), `T2: 50`, `T3: 67` (one 60fps frame), `T4: 100`.
- `DEFAULT_THRESHOLDS.interactionStepMs = 67` covers `--flat-thresholds`.
- `computeVerdict` MUST compare `timing.median / events` against it. `REFERENCE_STEPS` and the divide-by-11 rule are removed.
- `--threshold-interaction` keeps its aggregate meaning for callers that set it explicitly, applied as `value / REFERENCE_EVENTS` where `REFERENCE_EVENTS = 11`, so an existing CI flag does not change meaning silently.

### E3 — the calibration is validated, not asserted

Against the 39 measured interactions:

| group | per-event range | verdict under E2 |
|---|---|---|
| plain components (Button, Switch, Dialog, CodeBlock, Accordion, Tabs) | 5.7 - 22.8 | pass |
| Button with loading and spotlight | 34.4 - 39.2 | pass at T3, fails at T1 |
| slider and comparison drags | 5.9 - 20.8 | pass |
| whole applications (`App.tsx`) | 45.5 - 205.9 | fails above 67 |

- The M30 complaint is resolved on its merits: 39ms throttled is 9.8ms unthrottled, inside a 120fps frame, so a Button with a spinner should not fail.
- Whole-application interactions above 200ms per event still fail, which is the signal worth keeping.

### E4 — a wedged CDP session is replaced, not reused

M30 F6 excluded `Tracing.tracingComplete timed out` from the retry because retrying on the same session failed with `Protocol error (Tracing.start): Tracing has already been started`.

- `CdpHolder` boxes the session so `enter` can swap it; `refreshCdpSession(page, holder)` detaches the old session, ignoring a detach failure, and installs a fresh one.
- `measureMount`, `measureRerender` and `explore` MUST read `session.cdp` for every send, trace and GC call. The original binding is named `initialCdp` on purpose: a leftover reference to the pre-recovery session is then a compile error rather than a `Target page, context or browser has been closed` at run time. Six such references existed after the first attempt and the rename found all of them.
- `enter` is the single entry path, used for the first entry as well as recovery. The extra session created at startup is cheaper than a second copy of the preamble drifting from the first, and it keeps M25's one-settle-per-module invariant.
- `isContextLostError` classifies the tracing timeout again.
- Measured outcome, stated rather than claimed: `trnscrpt/src/components/app/content-sections.tsx` still fails, now with its own `Tracing.tracingComplete timed out` instead of a misleading protocol error. The retry runs and the second trace times out too, so this component's trace genuinely never completes; it is not a race. What E4 fixes is the corruption, not this component.

## Open regression

`test/e2e/isolation.test.ts > strictmode > flags an effect that accumulates across invocations` passes on `902c690` (7.9s) and fails on this tree: strict-mode overhead measures 58-67% against an expected >110%, reproducibly, in isolation as well as in the full suite. Ruled out so far: `src/isolation.ts` is unmodified, the repo has no root `vite.config` for `configFile: false` to have changed, and `sampleStrictPair` uses `runHarnessSession`'s unchanged `enter`. Cause unknown; the fixture's cost depends on a window-global counter that resets on navigation, so the suspicion is a change in navigation or warmup ordering rather than in the budget work.

## Open questions

- A trace that never completes within 30s still ends the run. Whether that is a component too heavy to trace under 4x throttle or a tracing bug is unresolved; `content-sections.tsx` is the reproducer.
- The 4x throttle is itself a calibration. If it changes, every number here moves with it.
