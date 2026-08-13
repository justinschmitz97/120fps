# 120fps

Zero-config component performance profiler. Real browser, real metrics.

```bash
npx 120fps ./Button.tsx
```

Launches headless Chromium, extracts props via the TypeScript Compiler API, generates prop combinations, measures mount/unmount/rerender timing via CDP traces, discovers and stress-tests interactions, and produces a pass/fail verdict with tiered budgets.

## Which mode answers my question

| question | mode |
|---|---|
| Is it fast? | `npx 120fps ./Button.tsx` |
| Does it scale with its data? | `--curve` (auto-activates when a scaling prop is detected) |
| Which prop costs the most? | `--matrix` |
| Is it leaking, or degrading as it churns? | `--isolate memory` / `--isolate rerender` |
| Did I regress? | `--budget` in CI, against a saved baseline |
| Did the change I just made help? | `--compare HEAD` |

**All numbers are measured under 4× CPU throttle.** Budgets are calibrated for those conditions, so a 14ms mount is not 14ms on your users' machines — it is a number you can compare against a budget, a baseline, or the other side of a `--compare`.

## Install

```bash
npm install -D 120fps
```

Or run directly:

```bash
npx 120fps ./src/components/Button.tsx
```

## CLI

```
npx 120fps <component.tsx> [options]

Options:
  --fixture <path>               Fixture file for composed components
  --json <path>                  JSON output path (default: 120fps-report.json)
  --ci                           CI mode: JSON only, exit 1 on fail
  --samples <n>                  Samples per measurement (default: 10)
  --max-combos <n>               Prop combos to measure (default: 8)
  --explore-budget <seconds>     Total interaction exploration budget (default: 300)
  --init-fixture                 Write a starter fixture when auto-composition is rolled back
  --scale <n,n,...>              Scale points, ≥2 distinct positive integers (default: 1,5,20,50)
  --threshold-mount <ms>         Mount budget (overrides tier budget)
  --threshold-rerender <ms>      Rerender budget (overrides tier budget)
  --threshold-interaction <ms>   Interaction budget (overrides tier budget)
  --flat-thresholds              Use flat budgets instead of tiered
  --framework <react|vanilla|auto>  Framework mode (default: auto)
  --curve [prop:type]            Curve mode: mount/rerender across scale points
  --no-curve                     Disable auto-activation of curve mode
  --matrix                       Prop variation matrix mode
  --no-matrix                    Disable auto-activation of matrix mode
  --isolate <phases>             Isolated measurement: mount,rerender,unmount,memory,strictmode,all
  --memory-cycles <n>            Mount/unmount cycles for memory mode (default: 20)
  --no-isolate                   Disable isolation mode (overrides --isolate)
  --compare <gitref>             Measure the working tree against <gitref>, samples interleaved
  --save-baseline                Save current measurements as baseline
  --check                        Compare against baseline, fail on regression
  --budget                       Shorthand for --ci --check
  --no-baseline                  Skip baseline comparison in CI mode
  --no-cache                     Measure even when an unchanged component could reuse its baseline verdict
  --baseline-env <mode>          Baseline environment handling: strict|normalize|ignore (default: normalize)
  --report-md <path>             Write a markdown summary (GitHub step summary / PR comment body)
  --report-junit <path>          Write JUnit XML, one testcase per component
  --no-deltas                    Skip pairwise prop delta analysis
  --no-auto-scale                Skip auto-scaling prop detection
  --no-attribution               Skip cost attribution
  --no-auto-compose              Skip auto-composition inference
  --no-react-analysis            Skip React optimization detection
  --wrap <path>                  Provider wrapper module (auto: 120fps.setup.tsx at project root)
  --no-wrap                      Disable the provider wrapper, including auto-detection
  --css <path,...>               Global stylesheets to inject (auto: app/globals.css and friends)
  --no-css                       Disable stylesheet injection, including auto-detection
  --react-compiler               Force the React Compiler transform on (auto: babel-plugin-react-compiler in package.json)
  --no-react-compiler            Disable the React Compiler transform, including auto-detection
  --no-shims                     Disable Next.js module shims
  --no-preflight                 Attempt the run even when the component graph reaches a server boundary
  --no-transforms                Do not load the project's own Vite transforms (SVGR, vanilla-extract)
  --help                         Show help
  --version                      Print version
```

`--matrix` auto-activates when the prop space has ≥2 boolean/union axes with a small cartesian product; auto-activation prints an upfront notice naming the cell count before measuring, since it multiplies run time roughly cell-count×. `--no-matrix` disables auto-activation. When the full matrix exceeds 256 cells, the run falls back to pairwise cover — every value pair tested at least once, not every cell — and the report discloses how many cells were measured against the full count.

**Matrix runs do not participate in baselines.** A matrix report is a set of cells, not the single measurement a baseline entry holds, so `--save-baseline` stores nothing and `--check`/`--budget` compare nothing on a matrix run. Because matrix mode auto-activates, this can happen without anyone typing `--matrix` — so the run says so in its warnings. Pass `--no-matrix` to save or check a baseline for such a component.

`--curve` and `--matrix` are alternative whole-run modes and cannot be combined; passing both is a usage error. `--isolate` combines with neither.

## Report output

Each measured combo gets a verdict: `pass`, `warn`, or `fail`. **`fail`** means a median exceeded its budget — mount, rerender, or a per-step interaction cost. **`warn`** means nothing breached a budget but the numbers should not be trusted at face value: a timing was unstable, the mount cost was large relative to this machine's calibration, or React optimization detection found a memo bailout, context fan-out, or callback-identity problem. The run fails if any combo fails; `warn` never sets a non-zero exit code.

A timing is **unstable** when its coefficient of variation (CV — standard deviation over mean, in percent) exceeds 15% *and* its absolute spread exceeds 0.5 ms. Both halves matter: under driven frame pacing a sub-millisecond metric can swing 40% CV while the noise stays trivial. An unstable metric is reported, skipped for baseline comparison, and downgrades the combo to `warn` — it is evidence about the machine, not about the component. Raise `--samples` if it persists.

Every report also carries `warnings`: the disclosures about what the run did and did not measure — capped combos, pairwise cover, throttled sample counts, unsettled fonts, a noisy machine. They are printed under the table and carried in the JSON, the markdown summary, and the JUnit output.

Set `DEBUG=1` (or `true`, `*`, or any value containing `120fps`) to print the full error stack trace instead of just the message.

## Budgets & baselines (CI)

`--save-baseline` writes `120fps-baseline.json` at the project root (nearest `package.json` above the component). `--check` compares against it and exits 1 on regression; `--budget` is `--ci --check`. Per-component budget overrides live in `120fps.config.json` at the same root, keyed by the component path relative to that root (e.g. `"./components/ui/Button.tsx"`). Every numeric field in the config (`defaults`, `tolerance`, and each `components` entry) must be a finite number ≥ 0; anything else throws naming the offending key path and value, before any measurement runs.

### Environment fingerprint

Each baseline entry records the machine and configuration that produced it: CPU, cores, OS, Chromium version, CPU throttle, sample count, calibration timings, measurement mode, and the active stylesheets, provider wrapper, and React Compiler setting. `--check` classifies the pair and says which comparison it did:

| classification | meaning | comparison |
|---|---|---|
| `identical` | same machine and configuration | raw milliseconds |
| `normalizable` | same configuration, different or drifted hardware | each metric divided by its run's calibration, plus a 0.5 ms absolute floor |
| `incompatible` | stylesheets, wrapper, React Compiler, or mode differ | none — the mismatch is named, the run does not fail |
| `unknown` | baseline predates the fingerprint | raw milliseconds, with a warning |

**Same-machine comparison is trustworthy. Cross-machine comparison catches large regressions and will miss small ones.** Calibration is a DOM-insert plus forced layout: it tracks layout- and paint-bound cost well and script-bound cost poorly, so normalization narrows the hardware gap without closing it. For gating a merge, run save and check on the same runner.

`--baseline-env strict` fails the check on anything but `identical` — use it when your CI runner is pinned and you want drift to be loud. `--baseline-env ignore` always compares raw milliseconds. The default is `normalize`.

### Per-environment slots

One committed baseline meets many machines. Rather than forcing them to collide, entries are stored one slot per environment: the file is keyed by component *and* an environment digest (CPU model, cores, OS, Chromium major version, throttle, sample count, measurement mode, stylesheets, wrapper, React Compiler). Your laptop and the CI runner each get their own slot in the same file, and neither overwrites the other.

- **Saving** writes the slot for the machine you are on.
- **Checking** reads that machine's slot. If there is none, the run compares against the freshest slot from another machine, says so, and **cannot fail** — a cross-machine delta is not evidence of a regression.
- Slots untouched for 90 days are pruned on the next save, with a notice naming them. Machines get replaced; baselines must not accrete their ghosts.
- Keys are written sorted, so two branches that baseline different components merge textually.

A version-1 baseline file still loads: its entries are rekeyed into the slot their own recorded environment describes, and entries that predate the fingerprint land in a `legacy` slot that is readable but never written again.

### Reusing an unchanged component's verdict

For identical code in an identical environment, re-measuring redraws the same distribution — a check cannot change its answer. So `--check` skips measurement and reuses the stored verdict when every one of these holds: the run is a check (`--check` or `--budget`), the component's source fingerprint matches the one saved with the entry, and the entry's slot is this machine's. A reused result is marked `cached: true` in the JSON and named in the terminal output. A routine sweep where one component changed therefore takes seconds.

Reuse is deliberately narrow. These always measure:

- `--save-baseline` (it needs numbers), `--no-baseline`, and `--no-cache`
- `--baseline-env strict` or `ignore` — both ask for a comparison the stored verdict does not describe
- `--matrix`, `--curve`, and `--isolate` — an explicit mode measures something a stored combo verdict does not contain
- a baseline whose slot recorded a different sample count, mode, stylesheet set, wrapper, or React Compiler setting

`--no-matrix` and `--no-curve` do **not** disqualify reuse: they resolve to the same plain-combo mode the entry recorded, which the fingerprint already carries. That matters because a component whose props auto-activate matrix mode can only get a baseline with `--no-matrix`, and its checks must then be able to reuse it.

The fingerprint covers the component's import graph, the wrapper, the stylesheets, the prop preset module, `tailwind.config.*` / `postcss.config.*`, the lockfile, and the resolved flags. It cannot see a Tailwind utility emitted because of a class added in an unrelated file; `--no-cache` forces a measurement and `--save-baseline` refreshes the entry.

### Workflow

Baseline authority belongs in CI, not on laptops:

```yaml
# on main — record the numbers everyone checks against
- run: npx 120fps "src/components/**/*.tsx" --save-baseline
- run: git add 120fps-baseline.json && git commit -m "chore: update perf baseline"

# on pull requests — gate the merge
- run: npx 120fps "src/components/**/*.tsx" --budget
```

Run save and check on the same runner image so the check lands in the slot the save wrote. Local slots are personal: they accumulate in the same file and are pruned automatically, but if you would rather they never reach a commit, keep the baseline out of your own commits with

```
git update-index --skip-worktree 120fps-baseline.json
```

which leaves CI free to update the committed copy.

### CI surfacing

Teams adopt perf CI when the regression appears in the PR, not in a log nobody opens. 120fps emits the formats forges consume and never talks to a forge itself — no tokens, no network calls, no comment posting.

- `--report-md <path>` writes a GitHub-flavored markdown summary: verdict line, one table row per component, regressions expanded behind a `<details>` fold so a thirty-component sweep still fits a comment, and a footer naming the machine and how noisy it was. Works as `$GITHUB_STEP_SUMMARY` content and as a PR-comment body for any marketplace comment action; GitLab renders the same file.
- `--report-junit <path>` writes JUnit XML, one testcase per component, failure body carrying the regression numbers. Every CI system renders JUnit natively.

Both derive from the report alone, so they compose with every mode including cached and isolation runs. The JSON file remains the full data reference.

```yaml
- name: Measure components
  run: npx 120fps "src/components/**/*.tsx" --budget --report-md perf.md --report-junit perf.xml
  continue-on-error: true

- name: Publish to the job summary
  if: always()
  run: cat perf.md >> $GITHUB_STEP_SUMMARY

- name: Comment on the PR
  if: always() && github.event_name == 'pull_request'
  uses: marocchino/sticky-pull-request-comment@v2
  with:
    path: perf.md
```

`--budget` still sets the exit code; `continue-on-error` lets the summary publish before the job fails.

## Isolated measurement

`--isolate <phases>` replaces the combo sweep with focused micro-benchmarks, one browser pass per phase over a single prop combination. `all` expands to every phase and may appear anywhere in the list.

```
npx 120fps ./Button.tsx --isolate mount,rerender
npx 120fps ./Button.tsx --isolate all --memory-cycles 40
```

| phase | measures |
|---|---|
| `mount` | mount cost alone, teardown outside the traced window, 3 warmup cycles |
| `unmount` | teardown cost alone — served by the same pass as `mount` |
| `rerender` | stable (same props), prop-change (second combination), and churn: 10 alternating cycles with no GC between them, reported with a degradation ratio |
| `memory` | 20 mount/unmount cycles (`--memory-cycles`) between two forced GCs, reporting heap growth per cycle and whether a leak is suspected |
| `strictmode` | mount cost with and without `React.StrictMode`, sampled in interleaved pairs so both series see the same machine conditions |

The run fails when the isolated mount median exceeds its budget, when a leak is suspected (>8 KB retained per cycle), or when churn degrades more than 2×. A StrictMode overhead above 2× is reported as a warning, not a failure — double invocation is a development-mode property. Exploration, interaction measurement, and React optimization detection do not run, so `combos` is empty and portal-based tier classification is unavailable; use `--threshold-mount`, `--flat-thresholds`, or a config budget if a portal component needs a looser mount budget.

An isolation baseline is never compared against a standard one: `--check` classifies the pair `incompatible`, names the mismatch, and does not fail.

`--isolate` cannot be combined with `--curve` or `--matrix`. `--no-isolate` overrides it.

## Fixtures

For composed components (Accordion + Item + Trigger + Content), create a `.fixture.tsx` file:

```tsx
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "./Accordion";

export default function Scene() {
  return (
    <Accordion>
      <AccordionItem value="1">
        <AccordionTrigger>Section 1</AccordionTrigger>
        <AccordionContent>Content 1</AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
```

Place it next to the component (`Accordion.fixture.tsx`) for auto-detection, or pass it explicitly:

```bash
npx 120fps ./Accordion.tsx --fixture ./Accordion.fixture.tsx
```

For parameterized scaling, export a `scale` function:

```tsx
export function scale(n: number) {
  return (
    <Accordion>
      {Array.from({ length: n }, (_, i) => (
        <AccordionItem key={i} value={String(i)}>
          <AccordionTrigger>Item {i}</AccordionTrigger>
          <AccordionContent>Content {i}</AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
```

## Provider wrapper

Components that read context (theme, i18n, router, query client) need their providers. Put a `120fps.setup.tsx` at your project root — it is picked up automatically:

```tsx
import "../app/globals.css";
import { ThemeProvider } from "./theme";

document.documentElement.setAttribute("data-theme", "dark");

export default function Setup({ children }: { children: React.ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}
```

Top-level side effects run before the component module evaluates, so theme classes and locale registration are in place at the first mount. An optional `export const viewport = { width: 375, height: 667 }` sets the measurement viewport.

Point at a different module with `--wrap ./path/to/setup.tsx`, or turn it off with `--no-wrap`. The report records the wrapper's own mount cost (`wrapper.overheadMs`) and DOM nodes so you can subtract them.

## Stylesheets

An unstyled component is the wrong measurement — no preflight, no utility classes, no custom properties, no fonts. 120fps injects your global stylesheet into the harness automatically, probing these paths at the project root and taking the first hit:

```
app/globals.css   app/global.css   src/app/globals.css   src/app/global.css
src/styles/globals.css   styles/globals.css   src/index.css   src/global.css
```

Your own `postcss.config.*` runs as-is, because the harness serves from your project root — Tailwind 4 via `@tailwindcss/postcss` needs no extra configuration, and `@tailwindcss/vite` is loaded from your `node_modules` when your `package.json` lists it. The process working directory is never changed, so configs that resolve plugins against `process.cwd()` keep working.

Split stylesheets, or a path the probe does not know, go through `--css`; order is the cascade order:

```bash
npx 120fps ./Button.tsx --css ./src/styles/reset.css,./src/styles/tokens.css
```

`--no-css` turns injection off entirely, including auto-detection.

Before the first sample of every measurement session, the harness waits for `document.fonts.ready` (bounded at 5s), forces one layout, and lets two frames pass, so font swaps and style application do not land inside a measurement. The same gate runs whenever a provider wrapper is active, since wrappers import stylesheets too. If fonts never settle the run continues and the report carries a warning.

The report names the stylesheets it injected (`css.files`) and records them in the baseline fingerprint. A baseline saved before injection was active is reported as incompatible rather than silently compared — re-save it with `--save-baseline`.

## React Compiler

If your `package.json` lists `babel-plugin-react-compiler`, the harness runs your components through it — using your installed copy, not one 120fps ships — so you measure the code you ship instead of the code you wrote. Without it, every rerender pays for memoization the compiler would have done, and components that rely on it get reported as memo bailouts they do not have in production.

```bash
npx 120fps ./Button.tsx                       # auto-detected from package.json
npx 120fps ./Button.tsx --no-react-compiler   # measure uncompiled
npx 120fps ./Button.tsx --react-compiler      # force it on
```

When the transform is active the report header says `React Compiler: active (v1.0.0)`, memo-bailout findings become informational instead of downgrading the verdict, and the baseline fingerprint records it. Disabling it on a project that has it installed adds a warning to the report, because the numbers will be higher than production. If the package is listed but cannot be resolved, the run continues uncompiled and says so; `--react-compiler` turns that into an error instead.

## Tier Budgets

Components are auto-classified into tiers based on DOM complexity:

| Tier | DOM nodes | Mount | Rerender | Interaction |
|------|-----------|-------|----------|-------------|
| T1   | ≤ 10      | 14 ms | 10 ms    | 250 ms      |
| T2   | ≤ 40      | 44 ms | 30 ms    | 300 ms      |
| T3   | portals/anim | 60 ms | 36 ms | 350 ms     |
| T4   | > 40      | 80 ms | 48 ms    | 400 ms      |

## Project transforms

The harness never reads your `vite.config` — its plugins target their own Vite major and its server options are not measurement-safe. Two consequences, both handled:

**Transforms it can load, it loads.** If your project declares `vite-plugin-svgr` or `@vanilla-extract/vite-plugin`, the harness resolves that plugin from your own `node_modules` and applies it, with its dev-server and HMR hooks stripped so it cannot reach into the harness's server lifecycle. Both are verified end to end against a real project. Active transforms are recorded in the report and in the baseline fingerprint — a component measured with a transform is not comparable to one measured without it.

**Transforms it cannot load, it names.** An import like `icon.svg?react` or `query.graphql` in a project without the corresponding supported plugin produces a warning that names the plugin family and carries a stable code (`[transform:svgr]`), rather than a build failure deep inside Vite that never mentions it. If the run then dies for any reason, the same list is appended to the error.

`--no-transforms` measures without them.

## Remediation

The report names the finding; these are the moves. Each finding class prints its hint once per run, and the JSON carries the ids in `hints` so the wording can change without a schema change.

### Memo bailout

A memoized child re-rendered with equal-looking props, so something in them is a new reference each time. Hoist the object or array literal out of the parent's render, or wrap it in `useMemo`. If the prop is a callback, see callback identity.

### Context fan-out

Every consumer re-renders when the provider's value changes identity. Wrap the value passed to `Provider` in `useMemo`, and split one wide context into a value context and a setter context so consumers that only dispatch stop re-rendering on every read.

### Callback identity

An inline arrow is a new function on every render, which defeats `memo` on the child that receives it. Wrap it in `useCallback` with the values it closes over as deps, or move the handler out of the component when it closes over nothing.

### Portal orphans

Nodes the component portalled onto `document.body` were still there after unmount. Return a cleanup from the effect that created the container, and remove the container element itself — React removes what it rendered, not a host node you appended.

### Leak suspected

Something outlives the component. Return cleanups from effects that add listeners, timers, observers or subscriptions, and abort in-flight requests on unmount. A heap snapshot across two mount/unmount cycles in DevTools shows what is retaining the tree.

### Churn degradation

Later rerenders cost more than the first, so state is accumulating rather than replacing. Check for arrays or maps appended to on every update, and for effects that add a subscription without removing the previous one.

### Superlinear growth

Doubling the input more than doubles the time, so there is work per item that touches every other item. Look for a `filter`, `find`, or `includes` inside a `map` over the same list, and for layout reads interleaved with writes inside the loop.

### Scaling curves

`--curve` measured several scale points but the DOM node count never moved, so the growth class describes nothing that was rendered. Check that the prop actually drives what renders, or point `--curve prop:type` at the prop that does.

### Async wrapper setup

A component still fetching when the sample window closed is measured as its skeleton, and the report says so. Export `setup` from your wrapper module to stub the request before first render:

```tsx
// 120fps.setup.tsx
export function setup() {
  window.fetch = (async () => new Response(JSON.stringify(fixtureData))) as typeof window.fetch;
}

export default function Wrapper({ children }: { children: React.ReactNode }) {
  return <Providers>{children}</Providers>;
}
```

`setup` may be async; the harness awaits it before exposing its control API, so readiness implies setup completed. An optional `teardown` export runs once when the measurement session closes.

## Requirements

- Node >= 20
- A `tsconfig.json` is optional: prop extraction uses the nearest one it finds above the component, and falls back to ES2022 + bundler resolution + `react-jsx` when there is none
- Components (`.tsx`, `.jsx`) — React `>=18` must be installed in the profiled project for React mode; vanilla mode needs no React
- Chromium via Playwright — downloaded automatically on install; if your environment skips browser downloads (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`), run `npx playwright install chromium` once

## License

MIT
