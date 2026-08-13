---
kind: milestone
status: done
tests:
  - test/unit/measure.test.ts
  - test/unit/measure-harden.test.ts
  - test/unit/measure-harden2.test.ts
  - test/e2e/measure.test.ts
  - test/e2e/measure-harden.test.ts
  - test/e2e/measure-harden2.test.ts
---

# M2 — mount/unmount measurement

CDP trace per mount/unmount. Defaults: 4x CPU throttle, warmup 2, samples 10.

Non-obvious:
- Trace wraps ONLY the action, never harness startup; double-rAF settle fence; throttle always on during traced windows and warmup (suspended for inter-sample GC — M34).
- Frames are driven, not scheduled (M35): the measurement browser runs under begin-frame control with a frame pump, so the fences resolve at frame-production speed (~2ms) instead of 60Hz vsync (~33ms). Fences carry a 10s starvation watchdog. Combos that animate are re-measured under vsync pacing (`MountResult.pacing`).
- Scripting = FunctionCall+EvaluateScript+v8.compile+v8.run; trace durs µs→ms. P95 index = ceil(0.95*N)-1.
- Function props → marker string, rebuilt as noop browser-side.
- Trace data listener removed after each trace (handler accumulation); tracingComplete awaited with 30s timeout.
- Cleanup in finally.

Open: trace event taxonomy varies across Chromium versions (parsing conservative); double-rAF may miss very heavy async components.
