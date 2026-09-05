---
kind: milestone
status: draft
tests:
  - test/unit/readiness-timeout-names-the-wait-and-its-bound.test.ts
  - test/unit/readiness-bound-comes-from-the-environment.test.ts
---

# M125: the readiness wait says what it waited for and how long

Lane C (`src/browser/page-errors.ts`, `src/browser/session.ts`).

## Purpose

Two runs of run 6 stopped after ~30 s with `component harness did not become ready within timeout.
No page errors were captured.` and nothing else. Both pass when they run alone. The message names no
global, no bound, no cause and no way to wait longer, so a developer on a shared machine cannot tell
a slow machine from a wedged import, and has nothing to change. After this milestone the message
names the global the run waited for, how long it waited, the two usual causes, and the environment
variable that raises the bound; the bound itself is one value, no longer a literal repeated per call
site.

Run-6 evidence: `C:/Projekte/120fps-fieldtest/smoke/run6-smoke1/FINDINGS.md` (cluster 8),
`smoke/run6-smoke1/logs/{docmost,infisical}/real.log:1-3` (2 lanes, exit 2 at 38 s and 40 s),
`smoke/run6-solo1/logs/docmost/real.log:89` and `logs/infisical/real.log:53` (1 lane, exit 1 and
exit 0, `Total: 48.2s (… build 21s …)` and `Total: 49.7s (… build 31s …)`),
`smoke/run6-smoke1/RESULTS.tsv` (memos `build=23.3`, umbrel `build=23.9`, both passing under the same
2 lanes). Same cwd, same component, same flags in both runs; only `lanes` differed
(`smoke/run6-*/META.json`).

## Root causes (verified)

1. **The bound is a literal repeated per call site** — `src/browser/session.ts:50`
   (`const HARNESS_READY_TIMEOUT_MS = 30000;`, used at `:80-84`), `src/pipeline/analyze.ts:483`
   (`{ timeout: 30000 }`), `src/analysis/explorer.ts:395`, `src/analysis/react-profiler.ts:547,554`.
   No flag and no environment variable reaches any of them: the only `process.env` read in `src/` is
   `DEBUG` (`src/cli/main.ts:178,222,294,302,414`), and `KNOWN_FLAGS` (`src/cli/args.ts:63-107`)
   carries no timeout. The verifier: the failing context string `component harness` exists only at
   `src/pipeline/analyze.ts:474,486`, so both run-6 failures came from that site's literal.
2. **The message states a verdict, not an observation** — `enrichTimeoutError`
   (`src/browser/page-errors.ts:280-300`) with `errorDetailBlock` (`:258-263`) renders
   `${context} did not become ready within timeout.` plus one sentence about page errors. The
   verifier: the run-6 logs carry that whole line and nothing else; nothing in it distinguishes a
   machine that needed 35 s from a page that would never become ready.
3. **Nothing measures the wait, and nothing can scale it** — the aggregate `build` phase is the
   nearest proxy (bundle + dependency pre-bundle + readiness wait), and on a timeout no phase
   duration prints at all. `collectMachineInfo` (`src/pipeline/verdict-reuse.ts:54-66`) reports cpu
   model, cores and ram, no timing, and `os.loadavg()` is `[0,0,0]` on Windows (checked on the run-6
   machine, 24 cores), so a bound cannot be derived from a load signal.

## MUST

- **C1** A readiness timeout raised through `waitForReadyOrFatal` keeps the sentence
  `<context> did not become ready within timeout.` and its page-error sentence, and appends one
  sentence that names the global it waited for (`window.__120fps`), the measured wait in seconds, the
  two usual causes as possibilities, and `FPS120_READY_TIMEOUT_MS` as the way to wait longer.
- **C2** `waitForReadyOrFatal` owns the readiness deadline: the wait it is given may carry its own
  per-attempt bound, and the deadline is `FPS120_READY_TIMEOUT_MS`, default 90000 ms. A wait that
  ends in a timeout before the deadline is entered again; the failure is raised when the deadline has
  passed. A fatal page error still wins the race at any point, unchanged.
- **C3** `FPS120_READY_TIMEOUT_MS` is read as a positive whole number of milliseconds. Any other
  value leaves the default in place and is disclosed once per process through the warning channel
  `enterHarness` already uses.
- **C4** The bound is exported from `src/browser` as one value, so every readiness wait can adopt it
  without its own literal.

## MUST NOT

- Change the healthy path: a harness that becomes ready costs no extra call, no added delay and no
  extra output.
- Name a cause the run did not observe. The appended sentence offers possibilities and names no
  specific module, stylesheet or dependency (M121 and M123 own what a run actually observed).
- Spin: a wait that ended in under `READY_RETRY_FLOOR_MS` (100 ms) is not entered again. It gave up
  on its own, not on a bound, so re-entering it would burn the deadline in a tight loop.
- Raise the bound for a navigation failure: `gotoWithErrorContext` keeps today's message, since it
  waited for a document, not for the global.

## Verification

- C1, C2 — `test/unit/readiness-timeout-names-the-wait-and-its-bound.test.ts`: a wait that always
  times out under a small bound produces a message that keeps
  `did not become ready within timeout.`, names `window.__120fps`, the seconds waited and
  `FPS120_READY_TIMEOUT_MS`; a wait that times out once and then succeeds inside the bound resolves
  with no error and is entered twice; a fatal page error during a retried wait still produces the
  `failed before it became ready` message; a wait that resolves at once is entered once.
- C3 — `test/unit/readiness-bound-comes-from-the-environment.test.ts`: `90000` when unset; the parsed
  value for a positive whole number; the default for `0`, `-1`, `12.5`, `abc` and an empty value,
  each with a notice naming the variable and the default; the notice is returned once per process.
- Suite: the tests above plus every existing test of the files this milestone edits
  (`test/unit/page-errors.test.ts`, `test/unit/page-error-reaches-its-own-remedy.test.ts`,
  `test/unit/import-cycle-preflight-hit.test.ts`, `test/unit/bundler-error-presentation.test.ts`,
  `test/unit/harness-crash-warnings.test.ts`, `test/unit/isolation-orchestrate.test.ts`,
  `test/unit/css-injection.test.ts`, `test/unit/css-injection-harden.test.ts`).
- Types: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` clean.

Recorded run of this milestone's verification:

```
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json   -> TSC_CLEAN
vitest run test/unit/readiness-timeout-names-the-wait-and-its-bound.test.ts \
  test/unit/readiness-bound-comes-from-the-environment.test.ts --maxWorkers=2
  -> Test Files 2 passed (2), Tests 17 passed (17)
vitest run test/unit/page-errors.test.ts test/unit/page-error-reaches-its-own-remedy.test.ts \
  test/unit/import-cycle-preflight-hit.test.ts test/unit/bundler-error-presentation.test.ts \
  test/unit/harness-crash-warnings.test.ts test/unit/isolation-orchestrate.test.ts \
  test/unit/css-injection.test.ts test/unit/css-injection-harden.test.ts --maxWorkers=2
  -> Test Files 8 passed (8), Tests 265 passed (265)
```

Corpus, through `node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd E:/repositories-run5/shadcn-admin
--out C:/Projekte/120fps-fieldtest/smoke/lane-c/shadcn-admin --label <label> --timeout 600 --cli
C:/Projekte/120fps-fieldtest/scratch/lane-c/dist/cli/main.js -- src/components/ui/label.tsx --samples 3
--max-combos 2 --explore-budget 30 --no-deltas`, scratch dist built from this worktree:

- `FPS120_READY_TIMEOUT_MS=1` (label `ready-bound-1ms`) -> exit 2 in 5 s,
  `ready-bound-1ms.log:5-6`:
  `Error: mount phase failed of label.tsx: mount harness did not become ready within timeout. No page errors were captured.`
  `It waited 4 ms for the harness page to define window.__120fps. A machine busy with parallel work, or a dependency pre-bundle running for the first time, can push that wait past the bound. An import that never settles never ends it. FPS120_READY_TIMEOUT_MS=<milliseconds> raises the bound (default 90000).`
- `FPS120_READY_TIMEOUT_MS=soon` (label `ready-bound-invalid`) -> exit 0 in 80 s, `pass=true`,
  report written, and one line only (`grep -c` = 1), `ready-bound-invalid.log:88`:
  `FPS120_READY_TIMEOUT_MS="soon" is not a positive whole number of milliseconds; the harness readiness wait keeps its default of 90000 ms.`
- no variable set (label `m125-unaffected`) -> exit 0 in 82 s, `pass=true`,
  `Total: 1m 20s  (preflight 0s, build 1s, calibration 3s, mount 6s, rerender 3s, explore 3s, scale 0s, attribution 0s, analysis 1m 4s)`, no readiness line.

## Deferred

- A `--ready-timeout` flag: the value would have to be threaded from `src/cli/args.ts` through
  `src/pipeline` to reach `waitForReadyOrFatal`, which is lane B's surface. The environment variable
  reaches every call site with no cross-lane edit.
- `src/analysis/explorer.ts:395` and `src/analysis/react-profiler.ts:547,554` call
  `page.waitForFunction` directly and keep their 30 s literal and today's message until lane D adopts
  the exported bound; the interface request is with lane D.
- Lowering the bound below a call site's own per-attempt bound: the deadline governs whether a wait
  is entered again, never how long one attempt runs, so `src/pipeline/analyze.ts:483` keeps its 30 s
  first attempt until lane B adopts `harnessReadyTimeoutMs()`. Raising the bound, which is what the
  run-6 failures needed, works at every site that races through `waitForReadyOrFatal` today.
- Instrumenting time-to-ready as its own reported phase: the run-6 logs prove it is not measured, but
  the phase table is `src/report`/`src/pipeline` surface.
- A bound that scales with machine load: no load signal exists on Windows
  (`os.loadavg()` is `[0,0,0]`), and `MachineInfo` carries no timing.
- `nuxt.com` fails the same way with one lane (`smoke/run6-solo1/logs/nuxt.com/real.log:3`); a larger
  bound does not address that class, which is a page that never becomes ready at all.
