---
kind: package
status: draft
tests:
  - test/unit/prop-extract.test.ts
  - test/unit/prop-gen.test.ts
  - test/unit/stress.test.ts
  - test/unit/stress2.test.ts
  - test/unit/measure.test.ts
  - test/unit/measure-harden.test.ts
  - test/unit/measure-harden2.test.ts
  - test/e2e/harness.test.ts
  - test/e2e/stress.test.ts
  - test/e2e/stress2.test.ts
  - test/e2e/measure.test.ts
  - test/e2e/measure-harden.test.ts
  - test/e2e/measure-harden2.test.ts
---

## Purpose
Single npm package. Component file path → real-browser performance report. Auto-discovers props, interactions, state transitions. Zero config.

## Contract
### MUST
- `analyze(filePath, options?): Promise<Report>` — programmatic API
- CLI: `npx 120fps ./Component.tsx`
- Props from TypeScript types only
- Render in headless Chromium via Playwright
- Discover interactables via live DOM walk
- Measure via CDP traces
- Output: terminal table + JSON file
- Run inside user's repo, respect tsconfig/deps/React version
- All timings: median + P95 from N≥10 samples
- 4× CPU throttle default

### MUST NOT
- Require manual scenario files or Storybook
- Ship custom DOM/layout engine
- Modify user's source files
- Require global install

### Invariants
- Same file → same report structure (metrics vary by machine)
- No measurement without CPU throttle enabled
- JSON schema additive-only across versions

## API surface (implemented)

```typescript
// Prop extraction (M1)
extractProps(filePath: string): Promise<PropSchema[]>
generateCombinations(schemas: PropSchema[]): PropCombination[]

// Harness (M1)
buildAndServe(filePath: string): Promise<HarnessResult>

// Measurement (M2)
measureMount(harness: HarnessResult, options?: MeasureOptions): Promise<MountResult[]>
computeMedian(values: number[]): number
computeP95(values: number[]): number
parseTraceDuration(events: TraceEvent[]): ParsedDuration

interface MeasureOptions {
  samples?: number;       // default: 10
  cpuThrottle?: number;   // default: 4
  combos?: PropCombination[];
  warmupRuns?: number;    // default: 2
}

interface MountResult {
  comboIndex: number;
  props: PropCombination;
  mount: TimingResult;
  unmount: TimingResult;
  domNodeCount: number;
}

interface TimingResult {
  samples: number[];
  median: number;
  p95: number;
}
```

## API surface (planned — M5/M6)

```typescript
analyze(filePath: string, options?: AnalyzeOptions): Promise<Report>

interface AnalyzeOptions {
  framework?: 'react';
  maxPropCombos?: number;        // default: 64
  samplesPerInteraction?: number; // default: 10
  cpuThrottle?: number;          // default: 4
  maxExplorationNodes?: number;  // default: 200
  maxExplorationTime?: number;   // default: 60000 (ms)
  maxDepth?: number;             // default: 4
  output?: string;
}

interface Report {
  component: string;
  file: string;
  timestamp: string;
  machine: MachineInfo;
  calibration: CalibrationResult;
  propCombinations: PropCombination[];
  stateGraph: StateGraph;
  benchmarks: Benchmark[];
  scaling?: ScalingAnalysis;
  summary: Summary;
}

interface CdpMetrics {
  paintCount: number;
  paintDuration: number;
  layoutCount: number;
  layoutDuration: number;
  styleRecalcCount: number;
  styleRecalcDuration: number;
  scriptDuration: number;
  droppedFrames: number;
  domNodeCount: number;
  heapDelta: number;
}
```

## Non-goals (v0.1)
- Multi-framework support (React only)
- Visual HTML report
- Regression tracking / baseline diffing
- Bundle size analysis
