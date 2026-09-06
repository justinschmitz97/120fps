---
kind: milestone
status: draft
tests:
  - test/unit/explorer.test.ts
  - test/unit/an-external-link-is-not-exercised.test.ts
  - test/unit/the-discovery-line-counts-what-it-skipped.test.ts
  - test/unit/an-unstable-sample-on-a-hostile-machine-warns.test.ts
---

# M137: explore measures the component, not the browser it runs in

Lane H (`src/browser/discovery.ts`, `src/analysis/stress-patterns.ts`,
`src/analysis/exploration-loop.ts`, `src/report/stats.ts`). `src/analysis/explorer.ts` belongs to
lanes A and F; a change needed there is an interface request (I12).

## Purpose

Two of the eleven scaffolds generated for run 7 fail their verdict, and neither failure is about the
component. `create-vue` and `create-vite`'s Vue template both ship a footer of external links —
vite.dev, vuejs.org, and in the social templates bsky.app and discord — and explore discovers those
anchors, clicks each one eleven times per sample, and measures the browser's attempt to leave the
page. The per-step cost climbs from 234 ms to 2 614 ms across three samples, which is a real
measurement of a real cost, of the wrong thing. The React scaffolds click the same anchors and land
at 20-82 ms per step, so they warn instead of failing: the difference between PASS and FAIL on a
generated starter is which browser tab won a race. Separately, an interaction whose samples the noise
sentinel already calls `unstable` on a machine it already calls `hostile` still produces a hard FAIL,
although the same run's leak check withholds its own FAIL for exactly that reason. After this
milestone explore exercises the component's own interactions, says how many it declined to exercise
and why, and does not convert measurement noise on a busy machine into a verdict.

Evidence: `C:/Projekte/120fps-fieldtest/smoke/run7-new1/` — `scaffold-create-vue.json`
(verdict-fail, exit 1, 83 s, flag `slow-explore`), `scaffold-vite-vue-ts.json` (verdict-fail, exit 1,
80 s, `slow-explore`), `scaffold-vite-react-js.json`, `scaffold-vite-react-ts.json` and
`scaffold-vite-react-swc-ts.json` (pass-warn, exit 0, 86-105 s, all `slow-explore`), and the logs
under `smoke/run7-new1/logs/<repo>/`. Both Vue failures were reproduced twice.

## Root causes (verified)

The verifier for every item below: run-7 new-repo diagnosis (2026-09-06), refuted by default; logs
under `C:/Projekte/120fps-fieldtest/smoke/run7-new1/logs/<repo>/`.

1. **Discovery keeps every anchor that has an `href`** — `src/browser/discovery.ts:291`, with its twin
   at `:372`, accepts an anchor on the strength of its `href` alone. Nothing anywhere in `src`
   distinguishes a same-page anchor from one that leaves the origin: `target="_blank"` appears in no
   source file, and the only `page.context().newPage()` / `newPage()` calls are the harness's own
   (`src/analysis/explorer.ts:380`, `src/analysis/react-profiler.ts:604`,
   `src/browser/session.ts:148` and `:155`), so a popup a click opens is neither awaited nor closed.
   The verifier: the scaffold footers are exactly such anchors, and the exploration report names them
   as discovered interaction targets.
2. **Every discovered target is clicked eleven times per sample** — `rapid-toggle-11` is built by
   `buildRapidToggle11` at `src/analysis/stress-patterns.ts:117-123` (invoked at `:60`), and its
   clicks carry a per-attempt timeout of 3 000 ms at `:188`. Eleven clicks × three samples × the
   number of footer links is what the numbers below measure. The verifier: on create-vue the three samples cost 234 ms, 2 614 ms and 2 367 ms;
   on vite-vue-ts 422 ms, 2 808 ms and 2 908 ms — a monotonic escalation that a component's own
   toggle does not produce. Per-step: 215-255 ms against the T1 budget of 33 ms and the T4 budget of
   100 ms, hence FAIL. The React scaffolds measured 20-82 ms per step on the same class of anchor and
   passed with warnings; nothing about the component explains the difference.
3. **An unstable sample on a hostile machine still fails** — `src/report/stats.ts:100-101` returns
   `"fail"` before the `unstable` branches at `:103-108` are reached, so the noise classification
   cannot soften a threshold breach. The verifier: the run's own leak check already does the
   opposite — `src/analysis/isolation.ts:469-470` is the single place a noise signal withholds a FAIL
   — so the two halves of the same report treat the same evidence differently. M46 built the
   sentinel, M53 fixed what the numbers mean, and M64 fixed what the verdict says about them; none of
   the three reached this branch.

Not this milestone's: the explore phase's wall clock on the same scaffolds
(`explore: 1 combos, budget 60s each` under `--explore-budget 30`, 60 496-73 844 ms recorded on a
one-prop component) is M134's root causes 5-8 and its C5, sharpened there.

## MUST

- **C1** An anchor that would leave the page is not exercised. "Would leave the page" means: an
  `href` whose resolved origin differs from the harness page's origin, or an anchor carrying
  `target="_blank"` or `rel="external"`, or an `href` with a non-`http(s)` scheme
  (`mailto:`, `tel:`, `javascript:`). A same-page anchor — a fragment, or a same-origin path the app
  routes itself — is still discovered and still exercised.
- **C2** The exploration report says what it declined and why: one line naming how many interaction
  targets were skipped and the reason class (external link, new-tab link, non-http scheme). A run
  that skipped none prints no such line.
- **C3** No click opens a page the run does not close. If a click nonetheless produces a popup or a
  navigation away from the harness page, the run closes the popup, returns to the harness page, stops
  exercising that target, and records it as skipped under C2 — it does not measure the result.
- **C4** An interaction whose samples the noise sentinel classifies `unstable` on a machine it
  classifies `hostile` warns instead of failing, and the warning states that a FAIL was withheld
  because the machine could not repeat identical work identically. This mirrors the leak check's
  existing suppression (`src/analysis/isolation.ts:469-470`) and extends the noise handling M46
  introduced, M53 made honest and M64 made legible to the verdict path in `src/report/stats.ts`.
- **C5** C4 is scoped to the noise combination it names. `unstable` on a machine that is not
  `hostile` still fails; a stable sample on a hostile machine still fails; the JSON report carries the
  unsuppressed classification either way, so a consumer can tell what was withheld.

## MUST NOT

- Skip a same-page interaction. C1 removes targets that leave the origin, never targets the component
  owns. A single-page-app route change inside the same origin is the component's behaviour and stays
  measured.
- Navigate, block navigation globally, or install a request interceptor that changes what the page
  loads. C1 decides before the click; C3 is the safety net for what slips through.
- Change `rapid-toggle-11`'s shape, its eleven-click count, its per-click timeout or the state-graph
  ids it produces (M116 owns the replay contract).
- Change a verdict for any reason other than C4's exact combination, or change what the noise
  sentinel classifies. C4 changes what a classification *does*, not what it is (M46).
- Suppress the leak FAIL, or widen `src/analysis/isolation.ts:469-470`'s existing suppression.
- Touch `src/analysis/explorer.ts`. Lanes A and F own it; the `observerTiming` threading M134 needs
  there is F's, and this lane's need for it is interface I12.

## Verification

- **C1, C2** — `test/unit/an-external-link-is-not-exercised.test.ts` and
  `test/unit/the-discovery-line-counts-what-it-skipped.test.ts`: a fixture page with a cross-origin
  anchor, a `target="_blank"` same-origin anchor, a `mailto:` anchor, a fragment anchor and a
  same-origin route link yields exactly the last two as targets; the skip line names three and their
  reason classes; a page with no external anchors prints no skip line; the discovered set is
  otherwise byte-identical to today's.
- **C3** — extend `test/unit/explorer.test.ts`: a click that opens a popup leaves no open page after
  the run and the target is recorded as skipped; a click that navigates the harness page away returns
  to the harness page and stops that target.
- **C4, C5** — `test/unit/an-unstable-sample-on-a-hostile-machine-warns.test.ts`: `unstable` +
  `hostile` yields `warn` with the withheld-FAIL sentence; `unstable` + `noisy` yields `fail`;
  `stable` + `hostile` yields `fail`; the JSON carries the classification in all three; the existing
  pass and warn paths are unchanged.
- Types: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` clean.
- Suite: the tests above plus `test/unit/explorer.test.ts`,
  `test/unit/explore-degrades-instead-of-ending-the-run.test.ts`,
  `test/unit/explore-replays-state-invariant-path-once-per-edge.test.ts`,
  `test/unit/explore-stall-hint-names-effective-flags.test.ts`, `test/unit/noise*.test.ts`,
  `test/unit/isolation*.test.ts`, `test/e2e/explorer.test.ts`, then the full unit suite once before
  the lane's final commit.

Recorded run of this milestone's verification:

```
<filled by lane H: tsc result, the vitest invocations and their verbatim totals>
```

Corpus repros, through a `dist` built in `C:/Projekte/120fps-run7-lane-h`:

```
node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run7/scaffold-create-vue \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-h/scaffold-create-vue \
  --label m137-create-vue --cli C:/Projekte/120fps-run7-lane-h/dist/cli/main.js \
  -- src/components/HelloWorld.vue --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# expected: PASS or WARN, never FAIL on footer links (baseline verdict-fail, exit 1, 83 s);
#           the discovery line names N external anchors skipped

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run7/scaffold-vite-vue-ts \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-h/scaffold-vite-vue-ts \
  --label m137-vite-vue-ts --cli C:/Projekte/120fps-run7-lane-h/dist/cli/main.js \
  -- src/components/HelloWorld.vue --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# expected: same (baseline verdict-fail, exit 1, 80 s)

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run7/scaffold-vite-react-ts \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-h/scaffold-vite-react-ts \
  --label m137-vite-react-ts --cli C:/Projekte/120fps-run7-lane-h/dist/cli/main.js \
  -- src/App.tsx --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# expected: still pass-warn, exit 0, with the same skip line and fewer measured steps

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run6/umbrel/packages/ui \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-h/umbrel \
  --label m137-control --cli C:/Projekte/120fps-run7-lane-h/dist/cli/main.js \
  -- src/components/ui/card.tsx --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# expected: unchanged pass-warn, exit 0, no skip line (no external anchors)
```

## Deferred

- **The explore phase's wall clock.** `explore: 1 combos, budget 60s each` under
  `--explore-budget 30`, and 60-74 s recorded on a one-prop component, is M134 S4/C5 in lane F, not a
  discovery defect.
- **Threading `observerTiming`** — declared at `src/analysis/exploration-loop.ts:80` and
  `src/analysis/explorer.ts:79`, read at `src/analysis/exploration-loop.ts:203` under the comment at
  `:202`, forwarded at `src/analysis/explorer.ts:433`, and never set by any caller in `src`.
  `explorer.ts` is lane A's and F's file; M134 C5 owns the threading, and this lane's dependency on
  it is interface I12.
- **A per-target cost cap.** Capping how long one interaction may cost would also have masked this
  defect, which is why it is not the fix: the anchors should not have been exercised at all.
- **Anchors that leave the origin but are the component's own subject** (a link-preview component, a
  router `<Link>` to an external site). C1 declines to exercise them and says so; measuring them
  safely needs its own evidence.
