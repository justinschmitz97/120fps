---
kind: package
status: draft
tests:
  - test/unit/prop-extract.test.ts
  - test/unit/prop-gen.test.ts
  - test/unit/stress.test.ts
  - test/unit/stress2.test.ts
  - test/e2e/harness.test.ts
  - test/e2e/stress.test.ts
  - test/e2e/stress2.test.ts
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

## API surface

```typescript
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

interface Benchmark {
  name: string;
  interaction?: InteractionDescriptor;
  propCombo: number;
  samples: number[];
  median: number;
  p95: number;
  mean: number;
  mutations: number;
  cdpMetrics: CdpMetrics;
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
