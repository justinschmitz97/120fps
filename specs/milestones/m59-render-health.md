---
kind: milestone
status: implemented
tests:
  - test/unit/m59-render-health.test.ts
  - test/unit/m59-render-health-harden.test.ts
  - test/e2e/m59-render-health.test.ts
  - test/e2e/m59-render-health-harden.test.ts
---

# M59 — render-health gate & always-on page-error surfacing

## Purpose

`attachPageErrorCapture` buffers every `pageerror` and `console.error` of a
session, and the buffer is read in exactly one place: `enrichTimeoutError`. A
component that throws on mount without also causing a Playwright timeout —
a missing context provider, a required prop the extractor never populated —
is measured mounting and unmounting a broken tree, and reports
`domNodeCount: 0`, verdict PASS, exit 0, no error field anywhere. Dogfooding
reproduced that on ~8 components across 4 projects.

Two adjacent blind spots share the mechanism. The initial `page.goto` calls
sit outside the enrichment (only the `waitForFunction` after them is wrapped),
so a failure there prints `page.goto: Timeout 30000ms exceeded` and nothing
else. And a CDP tracing timeout escapes as two context-free lines: no phase,
no combo, no component, no next step.

## Contract

### C1 — page errors reach the combo that produced them

- `PageErrorCapture` MUST expose `drain(): PageErrorDrain`, returning
  `{ messages, fatal, dropped }` for events recorded since the previous drain
  (or since attach).
- `errors` and `summary()` MUST stay session-wide and unchanged: draining is
  non-destructive, so timeout enrichment keeps reporting the whole session.
- The drain segment MUST apply the same retention policy as the session
  buffer: dedupe by distinct message with a `(×N)` repeat suffix, cap at 20
  distinct entries, count the rest in `dropped`. The segment caps
  independently of the session buffer, so a combo late in a noisy run is never
  starved by earlier combos' distinct messages.
- `measureMount` MUST drain after each combo's samples and record the result
  on `MountResult.pageErrors`. `measureRerender` MUST do the same onto
  `RerenderResult.pageErrors`.
- `buildReport` MUST merge a combo's mount and rerender drains into
  `ComboReport.pageErrors: string[]` — order preserved, duplicates across the
  two phases collapsed, `(+N more dropped)` appended when either drain dropped
  entries. Absent when the combo produced no page errors.
- The merged record MUST respect the same 20-entry cap. Two full windows would
  otherwise put forty lines on one row, and the cap is what bounds the output;
  the overflow joins the dropped count.

### C2 — render-health gate

- `ComboReport.renderHealth?: "error" | "empty"`, absent for any combo that
  rendered at least one DOM node.
- `"error"` when `domNodeCount === 0` AND at least one drained event was
  **fatal**. Such a combo MUST NOT be `pass`: its verdict is `fail`, which
  overrides both the tier verdict and the scale-combo pass exemption, and the
  run's `pass` is therefore false.
- `"empty"` when `domNodeCount === 0` and nothing fatal was captured. The
  verdict MUST be whatever the budgets said — a component may render null
  legitimately.
- **Fatal means an uncaught page exception** (`pageerror`), never
  `console.error` output. React and Vue log dev warnings through
  `console.error`, and gating on those would fail healthy components. A render
  that throws reaches `pageerror` in both frameworks: React rethrows through
  `reportError` when no boundary catches it, Vue's dev `logError` rethrows by
  default. Non-fatal messages are still recorded and still printed — they are
  evidence, not a verdict.
- Terminal output MUST mark the affected row (`[render error]`,
  `[N page errors]`, `[no DOM]` on the verdict cell), list each combo's
  messages under a `Page errors` heading, and state the gate's reasoning once
  per affected combo.
- The `0 interactions found. Consider creating <stem>.fixture.tsx` line MUST
  be suppressed when any combo is `"error"`: a fixture does not fix a throw.
- Curve mode has no combos. A scale point that rendered 0 DOM nodes while a
  fatal error was captured MUST push a warning naming the point and MUST fail
  the run.

### C3 — every `page.goto` carries the captured errors

`gotoWithErrorContext` wraps the navigation in the existing
`enrichTimeoutError` pattern, and all four harness entry points MUST use it:
`enterHarness` (src/measure.ts), `enterHarnessPage` (src/analyze.ts), the
React-analysis probe (src/react-profiler.ts), and the explorer's `enter`
(src/explorer.ts).

### C4 — harness crashes name the phase in flight

- `enrichPhaseError(err, { phase, comboIndex?, component? })` MUST prefix the
  failure with the phase (`mount` | `rerender` | `explore` | `attribution`),
  the combo index in flight, and the component file.
- A stall-class failure (`Tracing.tracingComplete timed out`, rAF frame
  starvation, a crashed target) MUST additionally carry one remediation hint
  naming real flags.
- Enrichment MUST be idempotent: an error already carrying phase context
  passes through unchanged, so a nested phase cannot stack prefixes.
- The original message MUST survive inside the enriched one, so
  `isContextLostError` and the retry budget keep matching.
- `measureMount`, `measureRerender`, `explore` and `runReactAnalysis` MUST
  wrap their pass bodies with it.

### C5 — exit codes unchanged

0 pass / 1 verdict fail / 2 setup error. A render-error combo is a verdict
failure: `report.pass` is false and the CLI exits 1. Nothing here throws.

### MUST NOT

- No new timeout mechanism, no change to any existing timeout value.
- No behavior change for a component that renders DOM nodes: `renderHealth`
  and `pageErrors` are absent from its report, and its verdict is untouched.
- `errors` / `summary()` semantics unchanged, so every existing enrichment
  site keeps its output.

## Design

**Why a segment rather than a cursor.** The session buffer dedupes by distinct
message and caps at 20 distinct entries, so a cursor into it would report
nothing for a combo whose only error was a repeat of an earlier one — exactly
the crash-every-combo case. A second bucket, reset per drain, gives each combo
its own dedupe and its own cap while the session bucket keeps feeding
`enrichTimeoutError` unchanged.

**Why fatality is tracked at capture, not classified from text.** Deciding
"is this a real throw" from message text means maintaining a list of React and
Vue dev-warning prefixes that changes every minor release. The event source
already answers it: `pageerror` is an uncaught exception, `console` is
whatever the page chose to log.

**Why `renderHealth` and not a fourth verdict value.** `"pass" | "warn" |
"fail"` is consumed by baselines, CI serializers, matrix cells and budget
comparison. A render error is a *reason* for a fail, not a new outcome, so it
rides alongside the verdict the way `tier` and `measuredState` do.

**What the gate does and does not reach.** It catches the case the renderer
swallows: React's concurrent root reports a render or effect throw through
`reportError` and returns from `mount()` normally, so the pass keeps measuring
and the combo is what carries the failure. Vue mounts synchronously, so a
throw in `setup` or in a render function propagates out of the mount call and
aborts the run instead — exit 2, with C4's phase, combo and component context
on it. That is not a silent pass and the numbers are never published, so it
needs no gate of its own.

Also measured: React unwinds the whole root when an effect throws with no
boundary above it, so a component that painted and then threw ends the sample
with an empty DOM and is gated. That is the honest answer — nothing was on
screen when the scene was counted.

**Attribution window.** A combo's drain covers everything from the previous
drain to the end of its samples — its warmups, its mounts, its DOM probes, its
unmounts. An error fired asynchronously long after the render that scheduled
it can therefore land on the following combo. Both combos are reported, so the
information is present either way.

## Deferred

- Isolation mode has phases, not combos, and its report has no per-combo slot;
  it keeps the session-wide enrichment only.
- Per-scale-point `pageErrors` in `ScalingCurveReport`. Curve mode gets the
  run-level warning and the failed verdict; the per-point structure is M63's
  region.
- `--save-baseline` on a render-errored run stores that run's zeros with
  `pass: false`, the same as any other failing run. A later comparison against
  those numbers reads as a large improvement. Refusing to save a failed
  baseline is a broader question than this milestone.
