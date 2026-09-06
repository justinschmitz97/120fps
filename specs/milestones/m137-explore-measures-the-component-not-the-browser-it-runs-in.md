---
kind: milestone
status: draft
tests:
  - test/unit/explorer.test.ts
  - test/unit/an-external-link-is-not-exercised.test.ts
  - test/unit/the-discovery-line-counts-what-it-skipped.test.ts
  - test/unit/an-unstable-sample-on-a-hostile-machine-warns.test.ts
  - test/unit/explore-replays-state-invariant-path-once-per-edge.test.ts
  - test/e2e/an-external-link-is-not-exercised.test.ts
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

## Design

Three decisions a reader cannot recover from the code alone.

- **The anchor decision is made in Node, not in the page.** The browser walk extracts each anchor's
  resolved `href`, its `target` and its `rel` alongside the fields it already extracted;
  `classifyNavigationEscape` in `src/browser/discovery.ts` decides from those and
  `location.origin`. The rule is therefore testable without a browser, and the page-side walk keeps
  one shape.
- **What discovery declined travels out through `DiscoverOptions.onSkipped`, not the return type.**
  `discoverInteractions` still returns `InteractionDescriptor[]`. `exploreCombo` accumulates the
  reports from every discovery in the combo, keyed by reason and selector so a rediscovered anchor
  counts once, and emits C2's line through `onWarning`. The run's warning sink already dedupes by
  exact text, so combos that declined the same classes print one line.
- **C4's withholding runs after the noise classification exists.** `report.noise` is derived from
  the very metrics the combos carry, so it cannot exist while `buildReport` is writing verdicts.
  `withholdInteractionFailsUnderHostileNoise` therefore re-reads each failing combo once
  `report.noise` is attached, at the tightest budget either budget shape could have used: a fail
  that survives the tighter bound was never an unstable interaction's alone, so it is left standing.

## Verification

- **C1, C2** — `test/unit/an-external-link-is-not-exercised.test.ts` and
  `test/unit/the-discovery-line-counts-what-it-skipped.test.ts`: a cross-origin anchor, a
  `target="_blank"` same-origin anchor and a `mailto:` anchor are declined with their reason class,
  a fragment anchor and a same-origin route link are not; a page with no such anchors is returned
  unchanged and prints no line; the line's counts, its singular and plural forms, and its stability
  across two combos that declined the same classes. `test/e2e/an-external-link-is-not-exercised.test.ts`
  runs the same decision through a real browser on `fixtures/external-links.tsx`: three targets kept
  (`#content`, `/settings`, the button), four declined; `fixtures/interactive-basic.tsx` declines
  none and keeps its anchor.
- **C3** — `test/unit/explorer.test.ts`: a popup a click opened is closed and reported as
  `opened-a-page`; a page that lost the harness global reports `left-the-page`; a page that kept it
  (a same-origin route change) reports nothing; an unreadable page counts as gone; the watch clears
  between targets and leaves no listener behind.
- **C4, C5** — `test/unit/an-unstable-sample-on-a-hostile-machine-warns.test.ts`: `unstable` +
  `hostile` yields `warn` with the withheld-FAIL sentence; `unstable` + `noisy` yields `fail`;
  `stable` + `hostile` yields `fail`; the JSON carries the classification in all three; the existing
  pass and warn paths are unchanged; a mount breach, a render failure and a second failing combo all
  keep the run failing.
- Types: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` clean.
- Suite: the tests above plus `test/unit/explorer.test.ts`,
  `test/unit/explore-degrades-instead-of-ending-the-run.test.ts`,
  `test/unit/explore-replays-state-invariant-path-once-per-edge.test.ts`,
  `test/unit/explore-stall-hint-names-effective-flags.test.ts`, `test/unit/noise*.test.ts`,
  `test/unit/isolation*.test.ts`, `test/e2e/explorer.test.ts`, then the full unit suite once before
  the lane's final commit.

Recorded run of this milestone's verification (2026-09-06, `C:/Projekte/120fps-run7-lane-h` on
`run7/lane-h`, node 22.22.2, `pnpm install --frozen-lockfile`):

```
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
# exit 0, no output

npx vitest run test/unit/explorer.test.ts \
  test/unit/an-external-link-is-not-exercised.test.ts \
  test/unit/the-discovery-line-counts-what-it-skipped.test.ts \
  test/unit/an-unstable-sample-on-a-hostile-machine-warns.test.ts \
  test/unit/explore-degrades-instead-of-ending-the-run.test.ts \
  test/unit/explore-replays-state-invariant-path-once-per-edge.test.ts \
  test/unit/explore-stall-hint-names-effective-flags.test.ts \
  test/unit/noise-sentinel.test.ts test/unit/noise-warning-is-one-terminal-line.test.ts \
  test/unit/isolation-calc.test.ts test/unit/isolation-cli.test.ts \
  test/unit/isolation-harden.test.ts test/unit/isolation-orchestrate.test.ts \
  test/unit/isolation-orchestrate-harden.test.ts test/unit/isolation-phase-warnings.test.ts \
  test/unit/isolation-report.test.ts test/unit/interaction-step-budgets.test.ts \
  test/unit/portal-harden.test.ts --maxWorkers=2
#  Test Files  18 passed (18)
#       Tests  280 passed (280)

npx vitest run test/e2e/an-external-link-is-not-exercised.test.ts --maxWorkers=1
#  Test Files  1 passed (1)
#       Tests  2 passed (2)

npx vitest run test/e2e/explorer.test.ts --maxWorkers=1
#  Test Files  1 passed (1)
#       Tests  9 passed (9)

npx vitest run test/unit --maxWorkers=2
#  Test Files  2 failed | 342 passed (344)
#       Tests  2 failed | 4962 passed | 1 skipped (4965)
#   Duration  335.49s
# The two failures are the recorded baseline pair, unchanged by this milestone:
# test/unit/prop-cap-ranking.test.ts ("variant and size survive the 32-prop cap") and
# test/unit/vue-setup-inject-evidence.test.ts ("records why each specifier failed").
```

Corpus repros, through a `dist` built in `C:/Projekte/120fps-run7-lane-h` (2026-09-06, logs under
`C:/Projekte/120fps-fieldtest/logs/run7-lane-h/<repo>/`). Every run:

```
node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd <appDir> \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-h/<repo> --label <label> --timeout 600 \
  --cli C:/Projekte/120fps-run7-lane-h/dist/cli/main.js \
  -- <component> --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
```

| Repo, component | Label | Before | After | Skip line |
|---|---|---|---|---|
| scaffold-create-vue, `src/components/HelloWorld.vue` | `m137-create-vue` | verdict-fail, exit 1, 83 s; Vite 237.6 ms/step and Vue 3 34.1 ms/step against T1's 33 ms | PASS, exit 0, 19 s; 0 interactions, explore 1 s | `explore skipped 2 interaction targets that would leave the page (2 external links)` |
| scaffold-vite-vue-ts, `src/components/HelloWorld.vue` | `m137-vite-vue-ts` | verdict-fail, exit 1, 80 s; Bluesky 255.3 ms/step against T4's 100 ms | PASS, exit 0, 36 s; 8 interactions, the component's own button at 9.7-10.9 ms/step and the document scroll at 10.0-16.0 ms/step | `... (6 external links)` |
| scaffold-vite-react-ts, `src/App.tsx` | `m137-vite-react-ts` | pass-warn, exit 0, 91 s; Explore Vite 66.2 ms/step, Bluesky 44.2 ms/step | pass-warn, exit 0, 67 s; 8 interactions, none an anchor that leaves | `... (6 external links)` |
| umbrel (control), `src/components/ui/card.tsx` | `m137-control` | pass-warn, exit 0, 46 s, 0 interactions | pass-warn, exit 0, 45 s, 0 interactions | none |
| shadcn-admin, `src/components/skip-to-main.tsx` | `m137-same-page-anchor` | not measured before | pass-warn, exit 0, 88 s; the component's single `href="#content"` anchor exercised at 20.2 ms/step under `rapid-toggle-11` | none |

The last row is C1's negative: a component whose only interactive element is a same-page anchor is
still discovered, still exercised, and prints no line. `git status --porcelain` in each target
repository is empty after its run (umbrel's `package-lock.json` was already modified on
2026-09-05, before this lane existed).

## Deferred

- **Interface request — the one call site outside this lane's files.** C4's withholding is
  implemented in `src/report/stats.ts`, and it is invoked from the noise block of
  `createHarnessContextAttacher` in `src/pipeline/phases.ts` (three lines, immediately after
  `report.noise = noise`, plus one named import). That block belongs to no lane: A owns
  `presentBundlerFailure` in the same file and C owns the injected-stylesheet disclosure, neither of
  which this hunk touches. `buildReport` cannot host it, because `report.noise` does not exist
  while the verdicts are being written. The coordinator relocates it if a lane claims the block.

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
