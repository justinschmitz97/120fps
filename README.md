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
  --fixture <path>            Fixture file for composed components
  --json <path>               JSON output path (default: 120fps-report.json)
  --ci                        CI mode: JSON only, exit 1 on fail
  --samples <n>               Samples per measurement (default: 10)
  --scale <n,n,...>           Scale points (default: 1,5,20,50)
  --threshold-mount <ms>      Mount budget (default: tier-based)
  --threshold-rerender <ms>   Rerender budget (default: tier-based)
  --threshold-interaction <ms> Interaction budget (default: tier-based)
  --flat-thresholds           Use flat budgets instead of tiered
  --framework <react|vanilla|auto>  Framework mode (default: auto)
  --no-deltas                 Skip pairwise prop delta analysis
  --no-auto-scale             Skip auto-scaling prop detection
  --no-attribution            Skip cost attribution
  --no-auto-compose           Skip auto-composition inference
  --no-react-analysis         Skip React optimization detection
  --help                      Show help
  --version                   Print version
```

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

## License

MIT
