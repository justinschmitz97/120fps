---
kind: milestone
status: draft
tests:
  - test/unit/callback-identity-pass-is-bounded.test.ts
  - test/e2e/callback-identity.test.ts
  - test/e2e/callback-identity-harden.test.ts
---

# M128: the callback-identity pass measures each prop set once

Lane D (`src/analysis/react-profiler.ts`).

## Purpose

The React analysis phase is the median 62 % of a passing run's wall time in the 50-repo smoke pass
(41 s median, 76 s max at `--samples 3 --max-combos 2`). Profiling it shows the phase is one loop:
the callback-identity pass is 97 % of it, and two of its multipliers carry no information. It probes
the same prop set up to four times because the explorer's scale probes all pass `{}`, and it probes
`onCopyCapture` beside `onCopy`, which is the same function on the same element. For a leaf `Label`
that buys 62 s and produces one 3 ms finding.

After this milestone the pass measures each distinct prop set once, skips a capture-phase prop whose
bubble twin it already probes, collects garbage once per probed prop instead of once per arm, and
`renderAttribution` is measured in its own window so its counts no longer depend on how many arms ran.

Run-6 evidence: `C:/Projekte/120fps-fieldtest/smoke/run6-smoke1/FINDINGS.md` (section Numbers),
`smoke/run6-solo1/logs/ai-chatbot/real.json` (`phaseTimings.analysis` 65333 of `total` 89891) and
`logs/memos/real.json` (67177 of 98509).

## Root causes (verified)

Measured with temporary timers around every sub-step of `runReactAnalysis`, one run at a time,
nothing else running. Logs: `C:/Projekte/120fps-fieldtest/smoke/lane-d/{ai-chatbot,memos}/prof1.log`.

| sub-step | ai-chatbot | memos |
|---|---|---|
| setup (probe write, context, hook, nav + readiness wait, viewport + style settle, warmup, portal baseline) | 457 ms | 500 ms |
| memo-bailout pass, 6 combos | 649 ms | 631 ms |
| context-fan-out pass, 6 combos | 617 ms | 632 ms |
| **callback-identity pass, 6 combos** | **61931 ms (97.2 %)** | **65727 ms (97.3 %)** |
| attribution + portal count, 6 combos | 51 ms | 71 ms |
| `runReactAnalysis` wall | 63705 ms | 67562 ms |
| `phaseTimings.analysis` | 64000 ms | 68000 ms |

The phase is `runReactAnalysis` and nothing else: 63.7 s of 64.0 s, 67.6 s of 68.0 s.

1. **The pass re-measures prop sets it has already measured** — `src/analysis/react-profiler.ts:612`
   runs the pass once per combo index. `runReactAnalysis` receives 6 combos, not the 2 that
   `--max-combos 2` bounds: `src/pipeline/modes/combo.ts:115,140` appends four scale probes, whose
   whole prop set is `{ __120fps_scaleN: n }`. That key is a harness trigger, not a prop
   (`src/pipeline/build-report.ts:237-242` strips it from the reported props, which is why the
   report shows `props: {}` for combos #2-#5). Only the measurement entry acts on it
   (`src/harness/entry.ts:271-276,370-382`); the probe entry has no scale branch and renders one
   element (`src/analysis/react-probe-entry.ts:67-79` `mount`, `src/harness/entry.ts:76-81`
   `renderTree`), so those four combos do identical probe work. `src/analysis/isolation.ts:201`
   already drops them for the same reason. The verifier: `renderAttribution` is comparable across
   them — `renderCount` 193 on ai-chatbot and 205 on memos for every combo. Distinct prop sets per
   run: 3 of 6.
2. **The pass probes a capture-phase prop beside its bubble twin** — `fnPropNames` is every schema of
   `kind === "function"`, uncapped (`src/pipeline/modes/combo.ts:267-269`,
   `src/pipeline/modes/context.ts:117-119`). For `label.tsx` that is 16 inherited React DOM handlers
   on ai-chatbot (`onToggle,onBeforeToggle,onCopy,onCopyCapture,onCut,onCutCapture,onPaste,
   onPasteCapture,onCompositionEnd,onCompositionEndCapture,onCompositionStart,
   onCompositionStartCapture,onCompositionUpdate,onCompositionUpdateCapture,onFocus,onFocusCapture`)
   and 17 on memos. 7 and 8 of them are `X + "Capture"` whose base `X` the same list already carries.
   Both are plain props forwarded to the same element, so an identity change in either drives the
   same render; the pair measures one thing twice.
3. **Garbage is collected once per arm** — `src/analysis/react-profiler.ts:620`, inside `measureArm`.
   Arms are `distinct prop sets × fnProps × samples × 2`: 576 on ai-chatbot, 612 on memos. Per arm:
   `tryCollectGarbage` 28.0 / 24.4 ms, `mountWithStableCallbacksProbe` 34.7 / 36.3 ms, `collectTrace`
   44.7 / 46.7 ms, 107.5 / 107.3 ms together. The alternation at `:632-639` is what defends the two
   arms against a drifting baseline; a collection between the two arms of one sample is not what
   makes them comparable.
4. **`renderAttribution` measures the pass, not the component** — `:642` reads `fullSnap` with no
   `resetProfilerData` since `:598`, so its `renderCount` and durations are almost entirely the
   callback arms. The field therefore varies with `fnPropNames.length` and is undefined today: 193
   renders of a `Label` that the report presents as the component's own attribution.

## MUST

- **D1** The callback-identity pass runs at most once per distinct serialized prop set, counting
  `__120fps_scaleN` as absent because the probe entry has no branch for it. Every combo whose props
  are equal under that rule reports the same `callbackIdentityDeltas`, and every combo index present
  in the input still has an entry in the result.
- **D2** The pass skips a prop named `X + "Capture"` when `X` is in the same list. A capture-phase
  prop with no bubble twin in the list is still probed.
- **D3** The pass collects garbage once per probed prop, before that prop's first arm, and not
  between arms.
- **D4** `renderAttribution` is measured in its own profiler window — a reset, a mount and one
  rerender — so its `renderCount` and durations describe the component and never depend on
  `fnPropNames.length` or on the callback-identity pass. Field name and shape are unchanged.
- **D5** The work the pass performs is bounded and asserted without a browser: for `n` distinct prop
  sets, `p` probed props and `s` samples it performs `n × p` garbage collections and
  `n × p × s × 2` measured rerenders.

## MUST NOT

- Change what a delta means: `stableMs` and `freshMs` stay `parseTraceDuration().totalDuration`, the
  0.5 ms report floor (`src/analysis/react-profiler.ts:44`) and the 2 ms warn threshold (`:163`)
  are untouched, and the arms still alternate.
- Change which props are reported: a delta for prop `P` appears on every combo whose prop set was
  measured, as it does today.
- Change `memoBailout*`, `contextFanOut*` or `portalOrphans`: all three stay measured per combo
  index. `portalOrphans` counts against one baseline read before the loop, so skipping a combo's
  orphan count would change the number a portal-creating component reports.
- Edit `src/pipeline/**` or `src/browser/trace.ts`. The prop filter lives in
  `src/analysis/react-profiler.ts`.

## Verification

`node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → clean.

`node node_modules/vitest/vitest.mjs run test/unit/callback-identity-pass-is-bounded.test.ts
test/unit/react-profiler.test.ts test/unit/react-profiler-harden.test.ts
test/unit/react-profiler-report.test.ts test/unit/callback-identity.test.ts
test/unit/callback-identity-harden.test.ts test/unit/render-attribution-across-modes.test.ts
test/unit/attribution-window.test.ts test/unit/attribution-window-harden.test.ts
test/unit/hints.test.ts test/unit/react-compiler.test.ts test/unit/react-compiler-harden.test.ts
--maxWorkers=2` → `Test Files 12 passed (12)`, `Tests 277 passed (277)`.

`node node_modules/vitest/vitest.mjs run test/e2e/callback-identity.test.ts
test/e2e/callback-identity-harden.test.ts --maxWorkers=2` → `Test Files 2 passed (2)`,
`Tests 8 passed (8)`.

Same-window interleaved A/B: base scratch built from `3db7b79`, M128 scratch from this worktree,
run `base, M128, base, M128`, one run at a time, nothing else running. Command per run:
`node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd <cwd> --out
C:/Projekte/120fps-fieldtest/smoke/lane-d/<repo> --label <label> --timeout 600 --cli <scratch>
-- <component> --samples 3 --max-combos 2 --explore-budget 30 --no-deltas`.

`phaseTimings.analysis`, verbatim, ms:

| repo | base A | M128 A | base B | M128 B |
|---|---|---|---|---|
| ai-chatbot (`E:/repositories-run5/ai-chatbot`, `components/ui/label.tsx`) | 62194 | 14749 | 63397 | 14328 |
| memos (`E:/repositories-run6/memos/web`, `src/components/ui/label.tsx`) | 65526 | 15672 | 62508 | 14896 |

`phaseTimings.total`, verbatim, ms:

| repo | base A | M128 A | base B | M128 B |
|---|---|---|---|---|
| ai-chatbot | 82196 | 34966 | 83086 | 33943 |
| memos | 81994 | 34106 | 78753 | 31776 |

Median `analysis`: ai-chatbot 62796 → 14539 ms (−76.8 %), memos 64017 → 15284 ms (−76.1 %). Median
`total`: 82641 → 34455 ms (−58.3 %) and 80374 → 32941 ms (−59.0 %). Arms per run fell from 576 to
162 (ai-chatbot) and 612 to 162 (memos): 3 prop sets × 9 probed props × 3 samples × 2. Measured on
the M128 build before the scale-trigger rule was added, the key saw 6 prop sets and the pass took
28715 ms, which is what fixed root cause 1.

Report fields the pass feeds, diffed base vs M128 across all four runs of both repos:

- `memoBailout`, `contextFanOut`, `compilerActive`, `portalOrphans`, `durationsUnavailable`: equal on
  every combo of both repos in all four runs (`memoBailout=false`, `contextFanOut=false`,
  `compilerActive=true`, the other two absent).
- Combo verdicts: ai-chatbot `warn,warn,pass,pass,pass,pass` and `pass=true` in all four runs.
  memos `warn,warn,pass,pass,pass,pass` and `pass=true` in base A, base B and M128 B; M128 A read
  `warn,fail,pass,pass,pass,pass`, `pass=false`. Explained, and not this milestone's code: combo #1's
  fail comes from its scroll-sweep interaction at 34.121 ms against the T1 `interactionStepMs` budget
  of 33 (`src/report/types.ts:40`), decided by `comboVerdict` (`src/report/stats.ts:101`) on a
  measure-phase number. That interaction is `unstable: true` with a CV of 33-41 % in every one of the
  four runs (samples `[45.168, 21.722, 34.121]` on M128 A against `[34.875, 19.372, 16.938]` on base
  A), and its p95 exceeds 33 ms on base A too. Nothing M128 changes runs before that measurement:
  `runReactAnalysis` is called after every timing is taken (`src/pipeline/modes/combo.ts:271`) and
  only ever raises a `pass` to `warn` (`:288`).
- `hints`: ai-chatbot `["harnessFault"]` in all four runs. memos `null` in base A, base B and M128 B;
  `["callbackIdentity","budgetBreach"]` in M128 A, `budgetBreach` from the verdict above.
- `callbackIdentityDeltas`: the finding is run-to-run unstable on the base build, so equality was
  never a property of it. Five base runs of memos reported `#3 onBlurCapture 1.56`
  (`smoke/run6-smoke1`), `#2 onCutCapture 4.05` (`smoke/run6-solo1`), `#1 onBlur 3.06`
  (`smoke/lane-d/memos/prof1.json`), then nothing twice (base A, base B) — a different prop on a
  different combo, or none, every time. M128 reported `#0 onBlur 2.89` once and nothing once, inside
  that spread. ai-chatbot base reported `#2 onCompositionEnd 1.74` and `#5 onCopy 1.39`, then
  `#0 onCopyCapture 1.19` and `#3 onCompositionStart 0.90`, then nothing twice; M128 reported nothing
  twice. Every value in every run sits between the 0.5 ms report floor and 4.1 ms.
- `renderAttribution`: changed by design (D4). The component set is unchanged on both repos and in
  every run — ai-chatbot `Label, Label, Primitive.label, label` on combos #2-#5 and empty on #0-#1,
  memos `Label, label` on every combo. `renderCount` is 2 everywhere against 193 (ai-chatbot) and
  205 (memos) on base, and the durations fall with it: ai-chatbot combo #2 `selfDurationMs`
  `[64.6, 52.0, 48.7, 16.4]` on base A, `[1.0, 0.6, 0.6, 0.4]` on M128 A. Consequence recorded: at
  that resolution the four ai-chatbot entries are within 0.9 ms of each other, so their order among
  near-ties varies between runs where the base's 193-render accumulation ranked them the same way
  every time. The two memos entries keep their order in three of four runs.

Unaffected corpus repo still reaching a report: both repos reach a report on both builds in all
eight runs, `exit=0`.

## Deferred

- **L4, a cheaper trace for this call site** — `src/browser/trace.ts:122-125` starts every arm's
  trace with `categories: "devtools.timeline,v8.execute"` and
  `options: "sampling-frequency=10000"`, and `parseTraceDuration` (`:32-81`) reads only `ph:"X"`
  events with a `dur`. Measured cost 44.7 / 46.7 ms per arm, ~7.2 s of the post-M128 pass; a
  narrower category set could return part of it. `src/browser/trace.ts` is lane C's file, and the
  change needs an options parameter on `collectTrace` that defaults to today's values. Not taken:
  M128 reaches 15 s without touching another lane's surface.
- **L5, mount once per probed prop instead of once per arm** — `:621` tears the root down and calls
  `createRoot` for every arm, 34.7 / 36.3 ms, ~5.6 s of the post-M128 pass. Alternating rerenders on
  one warm tree would return most of it, but `src/analysis/react-probe-entry.ts:105-107` states the
  mount is what installs the cached stable callback, and a warm tree measures a different thing than
  a freshly mounted one. Not taken without an A/B on all eight `m66-*` fixtures.
- **L6, skip the pass when the tree has no memo fiber and the compiler is inactive** — a fresh
  callback cannot defeat memoization that is not there, and
  `test/e2e/callback-identity-harden.test.ts:17-19` already asserts an empty result for
  `fixtures/m66-no-memo.tsx`. Both corpus targets report `reactCompiler.active: true`, so the gate
  would never fire on them. Not taken: extra code, no measured gain.
- Capping the number of probed props with a disclosure. The two multipliers M128 removes carry no
  information; a cap drops findings, so it needs its own evidence that the dropped props never
  mattered.
- Widening the attribution window past one rerender to steady the order of near-tied components.
  The four ai-chatbot entries land within 0.9 ms of each other, so their ranking moves between runs.
  More rerenders would raise the durations without necessarily separating them; taking it needs a
  measurement showing the order settles, not the assumption that it would.
- The callback-identity finding itself. Eleven recorded runs of two components produced a different
  prop, a different combo, or nothing every time, on both builds. That the measurement is unstable
  is a separate finding from how long it takes, and M128 does not touch what it means.
