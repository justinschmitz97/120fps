# 120fps

Zero-config component performance profiler. Real browser, real metrics.

```bash
npx 120fps ./Button.tsx     # React
npx 120fps ./Button.vue     # Vue
```

One command, one component file. You get:

- mount / rerender / unmount timings across generated prop combinations
- interaction costs: clicks, drags, scrolls, discovered from the DOM and stress-tested
- scaling behavior, memory leaks, React optimization findings (memo bailouts, context fan-out, callback identity)
- a pass / warn / fail verdict per combo, with tiered budgets and a remediation hint per finding

No config, no stories, no test IDs. Props come from your TypeScript types, the browser is headless Chromium, timings come from CDP traces.

## Which mode answers my question

| question | mode |
|---|---|
| Is it fast? | `npx 120fps ./Button.tsx` |
| Does it scale with its data? | `--curve` (auto-activates when a scaling prop is detected) |
| Which prop costs the most? | `--matrix` |
| Is it leaking, or degrading as it churns? | `--isolate memory` / `--isolate rerender` |
| Did I regress? | `--budget` in CI, against a saved baseline |
| Did the change I just made help? | `--compare HEAD` |

All numbers are measured under 4× CPU throttle. Compare them against budgets, baselines, or the other side of a `--compare`: not against production wall-clock.

## Install

```bash
npm install -D 120fps    # or just: npx 120fps ./Button.tsx
```

## CLI

```
npx 120fps <component.tsx|.jsx|.vue>[#ExportName] [options]

Options:
  --explain-props                Dry run: print the resolved component and prop schema, measure nothing
  --fixture <path>               Fixture file for composed components
  --json <path>                  JSON output path (default: 120fps-report.json)
  --ci                           CI mode: JSON only, exit 1 on fail
  --samples <n>                  Samples per measurement (default: 10)
  --max-combos <n>               Prop combos to measure (default: 8)
  --explore-budget <seconds>     Total interaction exploration budget (default: 300)
  --init-fixture                 Write a starter fixture when auto-composition is rolled back
  --scale <n,n,...>              Scale points, ≥2 distinct positive integers, overriding both defaults: combo-mode scale probes (default: 1,5,20,50) and curve-mode points (default: 1,3,5,10,20,50)
  --threshold-mount <ms>         Mount budget (overrides tier budget)
  --threshold-rerender <ms>      Rerender budget (overrides tier budget)
  --threshold-interaction <ms>   Interaction budget (overrides tier budget)
  --flat-thresholds              Use flat budgets instead of tiered
  --framework <react|vue|vanilla|auto>  Framework mode (default: auto)
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
  --baseline-file <path>         Baseline file --save-baseline writes and --check reads (default: <project root>/120fps-baseline.json)
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

Notes:

- `--matrix` auto-activates on ≥2 small boolean/union axes; the run announces the cell count first. Above 256 cells it falls back to pairwise cover and says how many cells it measured.
- Matrix runs don't participate in baselines. Use `--no-matrix` to save/check a baseline for such a component.
- `--curve`, `--matrix`, `--isolate` are exclusive whole-run modes; combining them is a usage error.
- Exit codes: 0 pass, 1 verdict fail (over budget, a regression under `--check`/`--budget`, or a render error), 2 setup/usage error.
- The harness readiness wait is bounded at 90s by default; raise it with the `FPS120_READY_TIMEOUT_MS` environment variable (a positive whole number of milliseconds) on a slow or busy machine.
- A Nuxt project whose `.nuxt/` directory is missing a file its own tsconfig names is refused before the browser starts, naming the missing file and the `nuxi prepare` remedy, in the dry run and the real run alike.
- A component whose import graph reaches a Babel macro (`*/macro`, `*.macro`, `babel-plugin-macros`) is refused before the browser, naming the importer, the macro and the compiler the project declares for it; `--no-preflight` bypasses the refusal and runs the rest of the pipeline unchanged.

### Which component gets measured

Default export → export matching the filename (`hotspot-image.tsx` → `HotspotImage`) → first exported component. Override with `#ExportName`:

```bash
npx 120fps ./kbd.tsx#KbdCombo
```

Unknown names error, listing the file's exports.

`--explain-props` shows what a run *would* measure: resolved component, its `file:line`, every prop with kind, required/default, and value pool, unsynthesizable props, whether curve/matrix would activate: without starting a browser. The `default` column prints only when at least one prop carries one. It also prints a `Composition:` line (`would auto-compose from <Root> (<n> exports)` or `would measure <Name> alone`), a `Matrix mode:` line when applicable, and ends with an estimate: `Estimated real run: ~2m 10s (8 combos x 5 samples; phase timings from 120fps-baseline.json)`. It uses recorded phase timings from a matching `--save-baseline` entry when one exists, documented defaults otherwise.

Runs print one line per phase (`mount: 8 combos x 10 samples`) and end with `Total: 4m 12s`. `--ci` prints JSON only. A monorepo run prints one `Roots:` line ahead of the component's table, naming the resolved member root and the workspace root; the line reads the same from any shell directory the CLI was started from (suppressed under `--ci`).

## Report output

- `fail`: a median broke its budget (mount, rerender, or per-step interaction). Any failing combo fails the run.
- `warn`: nothing broke a budget, but don't trust the numbers at face value: unstable timing, large cost vs calibration, or an optimization finding. Never affects the exit code.
- `unstable`: CV > 15% *and* spread > 0.5 ms. Reported, skipped for baseline comparison, downgrades to warn. Machine evidence, not component evidence; raise `--samples`.
- `warnings`: everything the run did or didn't measure (capped combos, noisy machine, unsettled fonts). In the terminal, JSON, and markdown output. A warning repeated for the same component prints once with a `(×N)` suffix; the JSON `warnings` array holds one entry per distinct text, in first-occurrence order.
- A noisy or hostile machine gets one terminal line naming only the signals that crossed threshold and the flag that helps: `machine: hostile (probe CV 53%, 100% of metrics unstable); raise --samples to measure through it.` The JSON keeps the full detail (`noise.level`, all four `noise.signals`, the full warning text); verdicts and budget lines read the same either way.
- Combos that crashed while rendering are `FAIL [render error]` with the page errors printed: see [render errors](#render-errors).
- `DEBUG=1` prints full stack traces.

## Where the minutes go

`Total:` breaks down by phase: `Total: 3m 12s  (build 41s, mount 58s, explore 1m 20s, analysis 12s)`; a phase at zero is left out. The JSON report carries the same numbers in `phaseTimings`: `preflight`, `build`, `calibration`, `setup`, `mount`, `rerender`, `explore`, `scale`, `deltas`, `attribution`, `analysis` and `total`, each an integer millisecond count, the eleven phase keys summing to `total`. `setup` holds the wrapper overhead, the calibration session's close, schema extraction and combination planning that used to be counted as calibration. `--report-md` includes the same breakdown per component; a report from before this existed renders `-`, never `0s`.

## Budgets & baselines (CI)

```yaml
# on main: record the numbers everyone checks against
- run: npx 120fps "src/components/**/*.tsx" --save-baseline
- run: git add 120fps-baseline.json && git commit -m "chore: update perf baseline"

# on pull requests: gate the merge
- run: npx 120fps "src/components/**/*.tsx" --budget
```

- `--save-baseline` writes `120fps-baseline.json` at the project root, or the file `--baseline-file <path>` names; `--check` reads the same file; `--budget` = `--ci --check`.
- Per-component overrides: `120fps.config.json`, keyed by component path. Invalid numbers throw before measuring.
- Save and check on the same runner image. Keep local baselines out of your commits with `git update-index --skip-worktree 120fps-baseline.json`.

Baseline entries record their environment (CPU, cores, OS, Chromium, throttle, samples, mode, stylesheets, wrapper, React Compiler). `--check` classifies each pair:

| classification | comparison |
|---|---|
| `identical` | raw milliseconds |
| `normalizable` | calibration-normalized, 0.5 ms floor |
| `incompatible` | none: mismatch named, run doesn't fail |
| `unknown` | raw, with a warning |

Same-machine comparison is trustworthy; cross-machine catches large regressions and misses small ones. `--baseline-env strict` fails on anything but `identical`; `ignore` always compares raw.

Entries are stored one slot per environment: laptop and CI runner share the file without overwriting each other. A missing slot compares informationally against the freshest other slot and cannot fail. Slots idle for 90 days are pruned on save.

In check mode, an unchanged component (same source fingerprint, same machine slot) reuses its stored verdict: `cached: true`, seconds instead of minutes for a sweep. `--no-cache` forces measurement; explicit modes, `--save-baseline`, and env changes always measure. The fingerprint can't see cross-file Tailwind utility changes: `--no-cache` when in doubt.

### CI surfacing

- `--report-md <path>`: verdict line + one row per component, regressions behind a `<details>` fold. A component with warnings gets its own fold listing its deduped `(×N)` warning texts. Use as `$GITHUB_STEP_SUMMARY` or a PR-comment body; GitLab renders it too.
- `--report-junit <path>`: one testcase per component; every CI renders JUnit.
- No tokens, no network calls: 120fps writes files, your CI posts them.
- A written report, baseline, or leftover harness directory inside the run's git repo and not covered by its `.gitignore` gets one tip after the last one, at the end of the process: `Tip: 120fps writes report/baseline files into this repo. Consider adding to .gitignore: <patterns>`.

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

## Isolated measurement

`--isolate <phases>` replaces the combo sweep with focused micro-benchmarks, one browser pass per phase, single prop combination.

```bash
npx 120fps ./Button.tsx --isolate mount,rerender
npx 120fps ./Button.tsx --isolate all --memory-cycles 40
```

| phase | measures |
|---|---|
| `mount` | mount cost alone, teardown outside the traced window |
| `unmount` | teardown cost alone |
| `rerender` | stable, prop-change, and churn (10 alternating cycles, degradation ratio) |
| `memory` | mount/unmount cycles between forced GCs, heap growth per cycle, leak verdict |
| `strictmode` | mount with vs without `React.StrictMode`, interleaved pairs |

Fails on: mount over budget, suspected leak (>8 KB/cycle), churn degrading >2×. StrictMode overhead >2× is a warning only. Isolation baselines never compare against standard ones.

## Fixtures

Composed components get a `.fixture.tsx` next to the component (`Accordion.fixture.tsx`, auto-detected) or via `--fixture`:

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

Export a `scale` function for parameterized scaling:

```tsx
export function scale(n: number) {
  return <Accordion>{Array.from({ length: n }, (_, i) => <AccordionItem key={i} value={String(i)}>…</AccordionItem>)}</Accordion>;
}
```

`--init-fixture` writes a starter fixture when a component never auto-composes but declares siblings: the bound root plus a `TODO` placeholder per sibling, and prints `wrote fixture scaffold <path>; edit it to render the real composition, then re-run`. If the target already exists it prints `--init-fixture skipped: <path> already exists` instead of overwriting it.

Prop values can also come from a preset: `<stem>.120fps.props.tsx`, `<stem>.120fps.props.ts`, `<stem>.props.tsx`, `<stem>.props.ts`, in that order, the first one shaped as a default-exported object literal (`export default { prop: [values] }`) wins. A candidate file under one of those names without that shape is reported by path, `exists, not a preset: no default-exported object literal`, and every remedy that would have named it points at `<stem>.120fps.props.tsx` instead. Once a preset loads, cap and collapsed-union warnings are re-checked against it: one the preset resolves stops printing, one that survives names the preset instead of asking you to add a file.

## Provider wrapper

Components that read context need providers. `120fps.setup.tsx` at the project root is picked up automatically (`--wrap` for a different path, `--no-wrap` to disable):

```tsx
import "../app/globals.css";
import { ThemeProvider } from "./theme";

export default function Setup({ children }: { children: React.ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}
```

Top-level side effects run before the component module. Optional `export const viewport = { width: 375, height: 667 }`. The report records the wrapper's own cost (`wrapper.overheadMs`).

## Stylesheets

Global stylesheets are injected automatically: first hit wins:

```
app/globals.css   app/global.css   src/app/globals.css   src/app/global.css
src/styles/globals.css   styles/globals.css   src/index.css   src/global.css
```

- Your `postcss.config.*` is read and normalized by 120fps itself, not handed to Vite's own config loader: a string plugin name, a `[name, options]` tuple, and an object-map entry all resolve, each plugin's package resolved from the directory that actually declares it, so a config re-exported from a shared tooling package still finds its plugins. Tailwind 4 works with no extra config. Tailwind 3 reads `tailwind.config.{js,cjs,mjs,ts}` from the member's own root first, then each ancestor up to the workspace root, whatever directory the CLI was started from, so the `Stylesheets:` line and warnings read the same from any shell directory.
- Split or unusual paths: `--css ./reset.css,./tokens.css` (cascade order). `--no-css` disables.
- Fonts settle before the first sample (`document.fonts.ready`, 5s bound); injected files are named in `css.files` and the baseline fingerprint.
- A package that generates its styling at runtime (Griffel, Emotion, `styled-components`, `@ant-design/cssinjs`, `antd-style`, `css-render`, PrimeVue) prints `Stylesheets: none — styling is generated at runtime by <engine>; no stylesheet was needed` instead of a fallback warning. A `makeStyles`/`createUseStyles`/`styled` import from an unrecognised package gets its own line naming the package and points at `--css`.
- A package whose `package.json` declares a stylesheet (`style`, `exports["./styles"]`, `exports["./style.css"]`) that isn't built yet is reported as declared but unbuilt: the field, the missing path and the package's build command, instead of falling back to size-ranked guessing. The report's `css.declaredMissing` carries the missing paths.
- A conventional-filename candidate whose Tailwind syntax contradicts the installed Tailwind major (a v4 `@import "tailwindcss"` sheet in a v3 project, or the reverse) is skipped before injection, naming the file, its dialect and the installed version, unless the project's own entry or manifest is what points at it. An injected stylesheet that throws while compiling, or does not finish within a 20s bound, is dropped and reported (`… did not compile within 20 s`) instead of ending the run, and the component may render unstyled.

## React Compiler

If `babel-plugin-react-compiler` is in your `package.json`, components are measured compiled: your installed copy, so you measure what you ship. Memo-bailout findings become informational.

```bash
npx 120fps ./Button.tsx                       # auto-detected
npx 120fps ./Button.tsx --no-react-compiler   # measure uncompiled
npx 120fps ./Button.tsx --react-compiler      # force on
```

The terminal names the resolved target: `React Compiler: active (v1.0.0, target 18)`. When the installed React major's runtime module isn't resolvable, the transform is skipped instead of failing the run: `React Compiler: skipped (target 18: react-compiler-runtime not installed)`. The JSON `reactCompiler` object carries `target` and, on a skip, the reason.

A component whose import graph reaches `react-native` (React Native Web apps such as Expo/RN-for-web projects) is measured through `react-native-web` when it's installed, the same substitution the app's own bundler makes; without it, the run stops naming React Native as the layer it cannot render and the file that imports it.

## Vue

```bash
npx 120fps ./Button.vue
npx 120fps "src/components/**/*.vue" --budget
```

- Needs `vue` and `@vitejs/plugin-vue` in *your* project: components compile against the versions they ship with.
- Props from `defineProps<T>()` / `withDefaults` in `<script setup lang="ts">`; imported types resolve. The runtime object form has no types → no props (still mounts and measures).
- `rerender()` awaits `nextTick()`: the traced window contains Vue's actual DOM patch.
- `120fps.setup.vue` wraps via its default slot; `.fixture.vue` for compounds.
- No `--isolate strictmode` (React-only concept), no Vue optimization pass yet. Framework is part of the baseline fingerprint.
- A read-of-undefined abort inside an ordinary SFC render frame gets a provide/inject hint pointing at `120fps.setup.vue` only when the component's own `<script setup>` block calls `inject(`; otherwise the abort prints no hint.
- The declaration files your own tooling generates are a resolution input, read as text and never executed. `components.d.ts` (also `src/`, `types/`, `app/`, `.nuxt/`) registers your project's own components globally before mount; `auto-imports.d.ts` (same search order) prepends the import for an identifier a module in the measured component's graph uses without importing it. Both are disclosed once per run with the file and the count, along with entries whose module is not on disk. A component the map points at inside a dependency stays unregistered, because it usually needs a router or a Nuxt app context the harness does not provide; the run names the ones your component's own source references. `@vitejs/plugin-vue` also resolves through a framework you *do* declare (`nuxt`, `vite`) that depends on it, with no hoisting warning.

## Tier Budgets

Auto-classified from DOM complexity; portals/animation raise the floor to T3.

| Tier | DOM nodes | Mount | Rerender | Interaction |
|------|-----------|-------|----------|-------------|
| T1   | ≤ 10      | 14 ms | 10 ms    | 250 ms      |
| T2   | ≤ 40      | 44 ms | 30 ms    | 300 ms      |
| T3   | portals/anim | 60 ms | 36 ms | 350 ms     |
| T4   | > 40      | 80 ms | 48 ms    | 400 ms      |

## Project transforms

- The harness never reads your `vite.config`, but loads supported plugins (`vite-plugin-svgr`, `@vanilla-extract/vite-plugin`, `@vitejs/plugin-vue`) from your `node_modules`, dev-server hooks stripped.
- Unloadable transforms are named with a stable code (`[transform:svgr]`) instead of failing deep inside Vite.
- `--no-transforms` measures without them. Active transforms are recorded in the report and fingerprint.
- The config's other declared plugins get one note per run naming what was dropped, in the config's own order: `vite.config.ts declares plugins the harness cannot honor: tanstackRouter, react — the project's Vite config is never executed.` A plugin whose transform the harness does apply (svgr, `@vitejs/plugin-vue`, vanilla-extract) is left out of the list, and the note is omitted entirely when nothing remains.
- An import of a file type Vite can't load without a plugin (`.yaml`, `.yml`, `.toml`, `.md`, beside `.graphql`/`.gql`) is flagged before the build fails; the message names the loader plugin your project declares for that extension when it declares one, generic wording otherwise.
- A `#`-prefixed specifier resolves through the nearest `package.json` `imports` field with Vite's own conditions; one that resolves to a file in your repo is measured as part of the graph, never flagged as missing. Nuxt's `#build`/`#imports`/`#app` diagnosis fires only when `nuxt` is actually declared in the project; otherwise the message names the missing specifier and the map that should declare it.
- An unbuilt workspace sibling is aliased to its own source entry (`source`, `exports`' `development`/`source`/`import` conditions, `module`/`main`, `types`, or `<pkg>/src`, in that order) instead of failing with a "needs a build step" diagnosis; the warning names the manifest field it followed and the path it resolved to. A sibling that declares no runtime entry at all is disclosed as types-only, with no `dist/` claim.

## Environment variables

`process.env` on the harness page is built from `.env` and `.env.local` files at the measured project's own root and, in a workspace, its workspace root too — read, never written. Only `NEXT_PUBLIC_*` and `VITE_*`-prefixed keys are forwarded, matching what a real Next.js or Vite production build actually exposes to the browser. The invoking shell's own environment is never read: a component that reads an unprefixed or shell-only variable, or `process.env` itself outside those files, measures `undefined`, the same as it would in production.

## Remediation

Each finding prints its hint once per run; ids are in the JSON `hints`.

### Memo bailout

A memoized child re-rendered on equal-looking props: something is a new reference each render. Hoist the literal or `useMemo` it.

### Context fan-out

Every consumer re-renders on provider value identity. `useMemo` the value; split value and setter contexts.

### Callback identity

Inline arrow = new function every render = broken `memo` on the child. `useCallback`, or move the handler out.

### Portal orphans

Portalled nodes survived unmount. Clean up the container in the effect that created it: React removes what it rendered, not host nodes you appended.

### Leak suspected

Something outlives the component. Return cleanups for listeners, timers, observers, subscriptions; abort in-flight requests.

### Churn degradation

Later rerenders cost more than early ones: state accumulates. Check for append-only arrays/maps and unremoved subscriptions.

### Superlinear growth

Doubling input more than doubles time: per-item work touches every other item. Look for `filter`/`find`/`includes` inside a `map`, and layout reads interleaved with writes.

### Scaling curves

Scale points measured but DOM count never moved: the curve describes nothing rendered. Check the prop drives rendering, or point `--curve prop:type` at the one that does.

### Render errors

Page errors during a combo are printed under `Page errors`; zero DOM + a throw = `FAIL [render error]`, and the run exits 1: the timings describe a broken tree, not your component. Usual causes: missing provider (`--wrap`), unpopulatable prop (`<stem>.props.tsx` preset). Rendering nothing *without* throwing is legal and only annotated.

A missing provider reads like this:

```
Page errors
  Combo #0:
    - @mantine/core: MantineProvider was not found in component tree, make sure you have it in your app

What to do about it:

  the component threw instead of rendering
    ...
    component imports @mantine/core, and the page error says "@mantine/core: MantineProvider was
    not found in component tree, make sure you have it in your app": render it inside that
    provider. A default-exporting 120fps.setup.tsx (or 120fps.setup.vue) at the package root is
    picked up automatically; --wrap names another path.
```

Write that wrapper once — the six-line recipe is under [Provider wrapper](#provider-wrapper) — and the same component measures.

### Harness fault

A combo can crash on a value 120fps chose for you rather than a value your code passed — most often a boolean like `asChild`/`as`/`render` whose `true` branch requires a specific `children` shape the synthesizer could not guarantee, or a placeholder value that turns out to appear verbatim in the thrown error. That combo is marked `[harness fault: <prop>]`, its verdict is never `FAIL`, and `Result: PASS` is unaffected even when it is the only combo that crashed. Add a `<stem>.props.tsx` preset naming the prop if you want that combo measured with a real value instead of excluded.

### Async wrapper setup

A component still fetching when the window closed is measured as its skeleton (and disclosed). Stub requests before first render:

```tsx
// 120fps.setup.tsx
export function setup() {
  window.fetch = (async () => new Response(JSON.stringify(fixtureData))) as typeof window.fetch;
}

export default function Wrapper({ children }: { children: React.ReactNode }) {
  return <Providers>{children}</Providers>;
}
```

`setup` may be async and is awaited before measurement; optional `teardown` runs at session close.

## Requirements

- Node >= 22
- React `>=18` in the profiled project (React mode); `vue` + `@vitejs/plugin-vue` (Vue mode); vanilla needs neither
- `tsconfig.json` optional: nearest one wins, sane fallback otherwise. When the nearest config declares no `compilerOptions` and only `references`, the referenced config that covers the file supplies `paths`/`baseUrl`/`jsxImportSource`/`customConditions` instead, disclosed once naming both config paths. `.ts`/`.tsx`/`.js`/`.jsx` always compile with the automatic JSX runtime, whatever the config's own `jsx` setting is. A `paths` key with no non-wildcard prefix (`"/*"`, `"*"`) builds no alias and is reported once instead of applied.
- `.scss`/`.sass` compiles with the project's own Sass when it resolves, otherwise with the copy 120fps ships, disclosed once naming the version; `.less` and `.styl`/`.stylus` need the project's own package, since 120fps bundles no implementation for either.
- Chromium via Playwright: run `npx playwright install chromium` once after installing (the Playwright package downloads no browser on `npm install`); a run without the browser stops with that command as its hint

## License

MIT
