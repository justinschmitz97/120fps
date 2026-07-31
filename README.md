# 120fps

Zero-config component performance profiler. Real browser, real metrics.

```bash
npx 120fps ./Button.tsx
```

Launches headless Chromium, extracts props via the TypeScript Compiler API, generates prop combinations, measures mount/unmount/rerender timing via CDP traces, discovers and stress-tests interactions, and produces a pass/fail verdict with tiered budgets.

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
  --scale <n,n,...>              Scale points (default: 1,5,20,50)
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
  --save-baseline                Save current measurements as baseline
  --check                        Compare against baseline, fail on regression
  --budget                       Shorthand for --ci --check
  --no-baseline                  Skip baseline comparison in CI mode
  --baseline-env <mode>          Baseline environment handling: strict|normalize|ignore (default: normalize)
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
  --help                         Show help
  --version                      Print version
```

## Budgets & baselines (CI)

`--save-baseline` writes `120fps-baseline.json` at the project root (nearest `package.json` above the component). `--check` compares against it and exits 1 on regression; `--budget` is `--ci --check`. Per-component budget overrides live in `120fps.config.json` at the same root, keyed by the component path relative to that root (e.g. `"./components/ui/Button.tsx"`).

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
| T1   | ≤ 12      | 2 ms  | 1 ms     | 50 ms       |
| T2   | ≤ 40      | 3 ms  | 1 ms     | 75 ms       |
| T3   | portals/anim | 6 ms | 2 ms    | 100 ms     |
| T4   | > 40      | 16 ms | 4 ms     | 100 ms      |

## Requirements

- Node >= 20
- TypeScript project with `tsconfig.json`
- React components (`.tsx`)
- Chromium via Playwright — downloaded automatically on install; if your environment skips browser downloads (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`), run `npx playwright install chromium` once

## License

MIT
