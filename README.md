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
  --no-deltas                    Skip pairwise prop delta analysis
  --no-auto-scale                Skip auto-scaling prop detection
  --no-attribution               Skip cost attribution
  --no-auto-compose              Skip auto-composition inference
  --no-react-analysis            Skip React optimization detection
  --no-shims                     Disable Next.js module shims
  --help                         Show help
  --version                      Print version
```

## Budgets & baselines (CI)

`--save-baseline` writes `120fps-baseline.json` at the project root (nearest `package.json` above the component). `--check` compares against it and exits 1 on regression; `--budget` is `--ci --check`. Per-component budget overrides live in `120fps.config.json` at the same root, keyed by the component path relative to that root (e.g. `"./components/ui/Button.tsx"`).

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
