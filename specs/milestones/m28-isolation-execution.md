---
kind: milestone
status: approved
tests: test/unit/m28-isolation.test.ts, test/unit/m28-isolation-harden.test.ts, test/e2e/isolation.test.ts
---

# M28 — isolation execution

Completed M23 (builders + formatter existed; `--isolate` validated input then ran the standard pipeline anyway). Behavioral contracts live in m23; execution facts here.

Non-obvious:
- "Isolated" is smaller than M23's prose: the standard pass ALREADY excludes unmount from mount timing, traces unmount separately, GCs per sample. Real content = focused per-phase pass over one combo, warmup 3, plus the three new measurements (churn/memory/strictmode).
- One pass serves BOTH mount and unmount phases; runs once at the earlier phase's position. Phase order fixed: mount, rerender, unmount, memory, strictmode.
- Strict wrapper fn named `__120fpsInStrict`, NOT `__120fpsWrapStrict` — M26's "no-wrapper entry never references __120fpsWrap" invariant is asserted by SUBSTRING search. StrictMode import unconditional (free when unused); probe entry keeps the plain form.
- Verdict tier: hasPortal=false (discovery doesn't run in isolation) ⇒ portal-dependent-T3 components get a STRICTER tier here; escape = --flat-thresholds or config budget. No mount phase requested → only memory/churn can fail. Budget via resolveComponentBudget; explicit --threshold-mount wins.
- Isolation baseline: mode:"isolation" in fingerprint; cross-mode --check → incompatible (M29). Empty interactions map is inert in compareBaseline (iterates recorded keys, skips ≤0 baselines). save/check hoisted into applyBaselineWorkflow — isolation branch returns before the combo path's copy.
- appendWarnings runs in ALL FOUR formatTable branches — the early-return branches (isolation/curve/matrix) previously hid every warning.
- runHarnessSession/enterHarness in measure.ts = the single session preamble (goto → __120fps gate + enrichTimeoutError → wrapper viewport → settle gate → throttle); was 5 copies. enterHarness re-runnable for StrictMode's mid-session ?strict=1 navigation.
- Fixed here (out of contract, e2e-surfaced): generated .tsx entry imports react/jsx-dev-runtime via automatic JSX transform, undeclared → cold optimizer discovered it on first load → full reload killed the execution context ~1 run in 3. reactJsxRuntimeDeps declares both runtime entries, resolved from the project (React 16 has no automatic runtime — skip).
- Type bridge: runners return raw number[]; analyze converts via buildTimingWithCV. No new timing type.
