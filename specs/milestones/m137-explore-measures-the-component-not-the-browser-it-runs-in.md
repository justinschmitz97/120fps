---
kind: milestone
status: approved
tests:
  - test/unit/explorer.test.ts
  - test/unit/an-external-link-is-not-exercised.test.ts
  - test/unit/the-discovery-line-counts-what-it-skipped.test.ts
  - test/unit/explore-replays-state-invariant-path-once-per-edge.test.ts
  - test/e2e/an-external-link-is-not-exercised.test.ts
  - test/e2e/a-click-that-opens-a-page-leaves-none-open.test.ts
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
generated starter is which browser tab won a race. After this milestone explore exercises the
component's own interactions and says how many it declined to exercise and why.

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
Not this milestone's: an unstable sample on a hostile machine still fails; that is Deferred below,
with the evidence that removed it from this milestone's scope.

Not this milestone's either: the explore phase's wall clock on the same scaffolds
(`explore: 1 combos, budget 60s each` under `--explore-budget 30`, 60 496-73 844 ms recorded on a
one-prop component) is M134's root causes 5-8 and its C5, sharpened there.

## MUST

- **C1** An anchor that would leave the page is not exercised. "Would leave the page" means: an
  `href` whose resolved origin differs from the harness page's origin, or an anchor carrying
  `target="_blank"` or `rel="external"`, or an `href` with a non-`http(s)` scheme
  (`mailto:`, `tel:`, `javascript:`). One carve-out: a `javascript:` anchor whose element also
  carries one of the handler attributes discovery already extracts (`onclick`, `onmousedown`,
  `onmouseup`, `onkeydown`, `onkeyup`, `onkeypress`) is a button the component owns, and stays
  exercised; a `javascript:` anchor carrying none of them is declined. The carve-out reads
  attributes, which is the only handler evidence discovery extracts; a framework-bound listener is
  Deferred below. A same-page anchor — a fragment, or a
  same-origin path the app routes itself — is still discovered and still exercised. The rule reaches
  every anchor the run would exercise, portal content included.
- **C2** The exploration report says what it declined and why: one line, in two clauses. The
  pre-click clause names how many interaction targets would leave the page and their reason class
  (external link, new-tab link, non-http link); the post-hoc clause names how many targets the run
  stopped exercising because the click itself left, and how (opened a new page, navigated away).
  Only the clauses with a count are printed, and a run that declined nothing prints no such line.
- **C3** No click opens a page the run does not close. If a click nonetheless produces a popup or a
  navigation away from the harness page, the run closes the popup, returns to the harness page, stops
  exercising that target, and records it as skipped under C2 — it does not measure the result. The
  test is the harness global, not the URL: a same-origin route change keeps it, so a routed click
  stays measured. A read that fails because the execution context was destroyed is the dev server
  reloading, not a click that left, and is left to the retry and stall paths that already own it.

## MUST NOT

- Skip a same-page interaction. C1 removes targets that leave the origin, never targets the component
  owns. A single-page-app route change inside the same origin is the component's behaviour and stays
  measured.
- Navigate, block navigation globally, or install a request interceptor that changes what the page
  loads. C1 decides before the click; C3 is the safety net for what slips through.
- Change `rapid-toggle-11`'s shape, its eleven-click count, its per-click timeout or the state-graph
  ids it produces (M116 owns the replay contract).
- Change a verdict, a budget or what the noise sentinel classifies. Budget verdicts stay absolute
  (`specs/overview/00-tdd.md:839`, `01-glossary.md:71`); this milestone changes which interactions
  are measured, never what a measured breach means.
- Suppress the leak FAIL, or widen `src/analysis/isolation.ts:469-470`'s existing suppression.
- Touch `src/analysis/explorer.ts`. Lanes A and F own it; the `observerTiming` threading M134 needs
  there is F's, and this lane's need for it is interface I12.

## Design

Three decisions a reader cannot recover from the code alone.

- **The anchor decision is made in Node, not in the page.** The browser walk extracts each anchor's
  resolved `href`, its `target` and its `rel` alongside the fields it already extracted;
  `classifyNavigationEscape` in `src/browser/discovery.ts` decides from those and
  `location.origin`. The rule is therefore testable without a browser, and the page-side walk keeps
  one shape.
- **What discovery declined travels out through `DiscoverOptions.onSkipped`, not the return type.**
  `discoverInteractions` still returns `InteractionDescriptor[]`. `exploreCombo` owns the record,
  keyed by reason and selector so a rediscovered anchor counts once, and emits C2's line from its
  `finally`: a combo that dies mid-walk still says what it did not measure, and the emission is
  guarded so it runs once. The run's warning sink dedupes by exact text, so combos that declined the
  same classes print one line.
- **The portal walk faces the same rule through the same function.** `src/browser/portal-probe.ts`
  runs its own `page.evaluate`, so it extracts the same three anchor fields and calls
  `classifyNavigationEscape` before `toDescriptor`. One rule, two walks; `discoverInteractions`
  hands it the origin it already read.

## Verification

- **C1, C2** — `test/unit/an-external-link-is-not-exercised.test.ts` and
  `test/unit/the-discovery-line-counts-what-it-skipped.test.ts`: a cross-origin anchor, a
  `target="_blank"` same-origin anchor and a `mailto:` anchor are declined with their reason class,
  a fragment anchor and a same-origin route link are not; each of the six handler attributes keeps a
  `javascript:` anchor, while a handled `mailto:` and a handled cross-origin anchor are still
  declined; a page with no such anchors is returned unchanged and prints no line; the two clauses are
  printed only when they have a count, in order, and the post-hoc clause counts targets rather than
  links. `test/e2e/an-external-link-is-not-exercised.test.ts` runs the same decision through a real
  browser on `fixtures/external-links.tsx` (three kept: `#content`, `/settings`, the button; four
  declined), on `fixtures/portal-external-links.fixture.tsx` (the portal keeps its fragment anchor
  and its close button, and declines its `target="_blank"` cross-origin anchor) and on
  `fixtures/interactive-basic.tsx` (nothing declined, its anchor kept).
  `test/unit/explore-replays-state-invariant-path-once-per-edge.test.ts`: a walk that throws after
  discovery still prints the line, exactly once, and a walk that declined nothing prints none.
- **C3** — `test/unit/explorer.test.ts`: a popup a click opened is closed and reported as
  `opened-a-page`; a page that lost the harness global reports `left-the-page`; a page that kept it
  (a same-origin route change) reports nothing; a destroyed execution context and a closed target
  report nothing; an unexplained read failure is re-read once before it counts, and reports nothing
  if it persists; the watch clears between targets and leaves no listener behind.
  `test/e2e/a-click-that-opens-a-page-leaves-none-open.test.ts` runs a combo against
  `fixtures/opens-a-window.tsx`, whose button calls `window.open`: the context holds one page
  afterwards, the graph has no edge for that target, and the notice names it.
- Types: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` clean.
- Suite: the tests above plus `test/unit/explorer.test.ts`,
  `test/unit/explore-degrades-instead-of-ending-the-run.test.ts`,
  `test/unit/explore-replays-state-invariant-path-once-per-edge.test.ts`,
  `test/unit/explore-stall-hint-names-effective-flags.test.ts`, `test/unit/noise*.test.ts`,
  `test/unit/isolation*.test.ts`, `test/unit/interaction-step-budgets.test.ts`,
  `test/e2e/explorer.test.ts`, then the full unit suite once before the lane's final commit.

Recorded run of this milestone's verification (2026-09-07, `C:/Projekte/120fps-run7-lane-h` on
`run7/lane-h` at the merged tree `cc506f0`, node 22.22.2, `pnpm install --frozen-lockfile`):

```
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
# exit 0, no output

npx vitest run test/unit/explorer.test.ts   test/unit/an-external-link-is-not-exercised.test.ts   test/unit/the-discovery-line-counts-what-it-skipped.test.ts   test/unit/explore-degrades-instead-of-ending-the-run.test.ts   test/unit/explore-replays-state-invariant-path-once-per-edge.test.ts   test/unit/explore-stall-hint-names-effective-flags.test.ts   test/unit/noise-sentinel.test.ts test/unit/noise-warning-is-one-terminal-line.test.ts   test/unit/isolation-calc.test.ts test/unit/isolation-cli.test.ts   test/unit/isolation-harden.test.ts test/unit/isolation-orchestrate.test.ts   test/unit/isolation-orchestrate-harden.test.ts test/unit/isolation-phase-warnings.test.ts   test/unit/isolation-report.test.ts test/unit/interaction-step-budgets.test.ts   test/unit/portal-harden.test.ts --maxWorkers=2
#  Test Files  17 passed (17)
#       Tests  280 passed (280)

# Three times, for the settle race the portal case used to lose one run in five:
npx vitest run test/e2e/an-external-link-is-not-exercised.test.ts   test/e2e/a-click-that-opens-a-page-leaves-none-open.test.ts --maxWorkers=1
#  Test Files  2 passed (2)      Tests  4 passed (4)      3 of 3 runs

npx vitest run test/e2e/explorer.test.ts --maxWorkers=1
#  Test Files  1 passed (1)
#       Tests  9 passed (9)     Duration  88.03s

npx vitest run test/unit --maxWorkers=2
#  Test Files  2 failed | 368 passed (370)
#       Tests  2 failed | 5265 passed | 1 skipped (5268)
#   Duration  448.68s
# The two failures are the recorded baseline pair, unchanged by this milestone:
# test/unit/prop-cap-ranking.test.ts ("variant and size survive the 32-prop cap") and
# test/unit/vue-setup-inject-evidence.test.ts ("records why each specifier failed").
```

Corpus repros, through a `dist` built in `C:/Projekte/120fps-run7-lane-h` (logs under
`C:/Projekte/120fps-fieldtest/logs/run7-lane-h/<repo>/`). Every run:

```
node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd <appDir>   --out C:/Projekte/120fps-fieldtest/logs/run7-lane-h/<repo> --label <label> --timeout 600   --cli C:/Projekte/120fps-run7-lane-h/dist/cli/main.js   -- <component> --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
```

| Repo, component | Label | Before | After | Skip line |
|---|---|---|---|---|
| scaffold-create-vue, `src/components/HelloWorld.vue` | `m137fix-create-vue` | verdict-fail, exit 1, 83 s; Vite 237.6 ms/step and Vue 3 34.1 ms/step against T1's 33 ms | PASS, exit 0, 15 s; 0 interactions; explore 1 m 14 s → 1 s | `explore skipped 2 interaction targets that would leave the page (2 external links)` |
| scaffold-vite-vue-ts, `src/components/HelloWorld.vue` | `m137fix-vite-vue-ts` | verdict-fail, exit 1, 80 s; Bluesky 255.3 ms/step against T4's 100 ms | PASS, exit 0, 44 s; 8 interactions — the component's own button at 12.2-16.0 ms/step, the document scroll at 14.8-20.7 ms/step | `... (6 external links)` |
| scaffold-vite-react-ts, `src/App.tsx` | `m137-vite-react-ts` | pass-warn, exit 0, 91 s; Explore Vite 66.2 ms/step, Bluesky 44.2 ms/step | pass-warn, exit 0, 67 s; 8 interactions, none an anchor that leaves | `... (6 external links)` |
| umbrel (control), `src/components/ui/card.tsx` | `m137-control` | pass-warn, exit 0, 46 s, 0 interactions | pass-warn, exit 0, 45 s, 0 interactions | none |
| shadcn-admin, `src/components/skip-to-main.tsx` | `m137-same-page-anchor` | not measured before | pass-warn, exit 0, 88 s; the component's single `href="#content"` anchor exercised at 20.2 ms/step under `rapid-toggle-11` | none |

The last row is C1's negative: a component whose only interactive element is a same-page anchor is
still discovered, still exercised, and prints no line. Both Vue scaffolds reach PASS on a machine the
sentinel called `hostile` (probe CV 46 % and 52 %), which is what makes the deferral below safe:
C1-C3 carry the fix on their own. `git status --porcelain` in each target repository is empty after
its run.

## Deferred

- **Withholding a per-step FAIL on a hostile machine (was C4, C5).** An interaction whose samples the
  noise sentinel calls `unstable` on a machine it calls `hostile` still fails, as every other budget
  breach does. Four findings removed it from this milestone:
  1. **The gate would swallow the verdict, not qualify it.** The measuring machine reports
     `machine: hostile` on 217 of 278 recorded runs and `quiet` on none, at probe CV 46-58 % on an
     idle 12-core box. A gate that fires on `hostile` makes the per-step interaction FAIL
     effectively unreachable.
  2. **The signal is circular.** `classifyNoise` reaches `hostile` on `unstableFraction` alone, and
     that fraction counts the component's own metrics: a jittery component would classify its own
     machine as hostile and then be excused by it. A future gate reads the probe signal only.
  3. **The reconstruction was unsound in the applied direction.** Taking the tighter of the two
     budget shapes keeps the FAIL for a T2-T4 combo whose mount sits inside its tier budget but
     outside T1's, and in flat-threshold mode. A future gate reconstructs with the combo's own
     effective budget, or is computed where that budget is still in hand.
  4. **It contradicts an approved contract.** "Budget verdicts are absolute" is stated at
     `specs/overview/00-tdd.md:839` and `specs/overview/01-glossary.md:71`, and the M117 known limit
     at `CHANGELOG:196-197` says the same. Any future gate amends those first.

  A future gate must therefore: read the probe signal only, never `unstableFraction`; carry a
  magnitude ceiling, so a 7x breach fails however noisy the machine was; and compare against the
  combo's own effective budget. C1-C3 turned both Vue scaffolds from FAIL to PASS without this gate
  ever firing: `withheld=false` in all five lane runs and in the reviewer's rerun.

- **A framework-bound listener on a `javascript:` anchor.** C1's carve-out reads the handler
  attributes discovery extracts (`hasAttribute("onclick")` and its five siblings). Vue's `@click`
  and React's `onClick` bind through `addEventListener` and event delegation, so they leave no
  attribute: `E:/repositories-run7/scaffold-create-vue/src/components/TheWelcome.vue:47`
  (`<a href="javascript:void(0)" @click="openReadmeInEditor">`) is still declined as a non-http
  link. Nothing in `src` reads `__vue`, `__vnode`, `__reactProps` or `_reactListening` today, so
  detecting it means teaching discovery a new class of evidence, with its own false-positive
  surface, rather than reusing one. The cost of the miss is bounded: the run declines a target it
  could have measured and says so on the skip line, which is the safe direction.

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

## Approval

Approved 2026-09-07 on the merged branch feat/run7-remediation (commits `88784fa`, `e70a846`,
`5bc4834`). Adversarial review by an independent agent: needs-fix → fixes → approve. Unit suite on
the merged tree: 391 files / 5455 passed / 2 pre-existing failures / 1 skipped.
