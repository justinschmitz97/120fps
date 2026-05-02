---
kind: milestone
status: done
tests:
  - test/unit/explorer.test.ts
  - test/e2e/explorer.test.ts
  - test/e2e/explorer-harden.test.ts
---

## Purpose
Adaptive exploration loop that exercises discovered interactions, tracks state changes via DOM hashing, and builds a state graph with timing data per edge.

## Contract
### MUST
- `explore(harness, options?)` accepts a `HarnessResult` and returns `ExploreResult[]` (one per prop combo)
- Manages browser lifecycle internally (launch, measure, close)
- For each prop combo: mount component, discover interactions via `discoverInteractions()`, exercise each, build `StateGraph`
- DOM hash: FNV-1a hash of `#root` innerHTML identifies unique DOM states
- State detection: after exercising an interaction, hash DOM; new hash = new `StateNode`
- Timing: each edge exercised N times (default 10) with CDP trace capture; each sample is independent (remount + replay to source state between samples)
- Each `StateEdge` contains: fromId, toId, interaction descriptor, samples array, median, P95, raw traces
- Adaptive deepening: if edge P95 > 1.5x global median edge cost, add follow-up interactions from destination state to priority queue front
- Convergence: binary information gain per exploration (1 if new node or edge, 0 otherwise); stop when last 10 explorations all have gain = 0
- Hard limits: 200 nodes (maxNodes), 60s wall-clock (maxWallClockMs), depth 4 (maxDepth)
- Seeded PRNG (default seed 42) for deterministic tie-breaking when shuffling interaction order
- 4x CPU throttle by default (matching M2)
- Warmup runs before measurement (default 2, matching M2)
- BFS traversal with priority boosting for expensive paths

### MUST NOT
- Parse full metrics from traces (M5)
- Produce reports (M6)
- Modify component source or the live DOM (beyond exercising interactions)

### Invariants
- Deterministic: same component + same seed + same options = same graph structure and exploration order
- All edges have exactly N samples (unless hard limits terminate exploration early)
- Graph is connected: all nodes reachable from initial node

## Types

```typescript
interface StateNode {
  id: string;                              // FNV-1a hash of DOM innerHTML
  depth: number;                           // hops from initial state
  interactions: InteractionDescriptor[];   // interactions discoverable from this state
  pathFromRoot: PathStep[];                // replay sequence to reach this state
}

interface PathStep {
  interaction: InteractionDescriptor;
}

interface StateEdge {
  id: string;                              // unique edge identifier
  fromId: string;                          // source state hash
  toId: string;                            // target state hash
  interaction: InteractionDescriptor;      // what was exercised
  samples: number[];                       // raw timing samples (ms)
  median: number;
  p95: number;
  traces: TraceEvent[][];                  // raw trace events per sample, for M5
}

interface StateGraph {
  nodes: Map<string, StateNode>;
  edges: StateEdge[];
  initialNodeId: string;
  wallClockMs: number;
}

interface ExploreOptions {
  samples?: number;           // default 10
  maxNodes?: number;          // default 200
  maxWallClockMs?: number;    // default 60000
  maxDepth?: number;          // default 4
  cpuThrottle?: number;       // default 4
  warmupRuns?: number;        // default 2
  seed?: number;              // default 42
  combos?: PropCombination[];
}

interface ExploreResult {
  graph: StateGraph;
  comboIndex: number;
  props: PropCombination;
}
```

## Design

### Exploration algorithm
1. Launch browser, create CDP session, apply CPU throttle
2. For each prop combo:
   a. Mount component, compute initial DOM hash, create root `StateNode`
   b. Discover interactions from initial state
   c. Shuffle interactions with seeded RNG, initialize work queue
   d. While queue non-empty and within limits:
      - Pop work item (sourceState, interaction, depth)
      - Collect N timing samples: for each, remount + replay path to source state, exercise interaction with trace capture
      - First sample also records target state hash
      - Create `StateEdge` with timing stats and raw traces
      - If target is new state: create `StateNode`, discover its interactions, add follow-up work items
      - If edge P95 > 1.5x global median: add follow-ups to priority queue front
      - Track convergence
   e. Record wall-clock time
3. Close browser, return results

### Interaction exercise
| type | Playwright action |
|------|-------------------|
| click | `page.click(selector)` |
| type | `page.fill(selector, 'test')` |
| select | `page.selectOption(selector, {index: 0})` |
| focus | `page.focus(selector)` |
| keyboard | `page.focus(selector)` then `page.keyboard.press('Enter')` |
| hover | `page.hover(selector)` |

Shadow DOM selectors (containing `>>>`) use `page.evaluate` fallback with manual shadow root traversal.

After each exercise: double `requestAnimationFrame` flush for React settle.

### DOM hashing
FNV-1a hash of `document.getElementById('root').innerHTML`.

### State navigation
Remount component, then replay `pathFromRoot` interaction sequence.

### Seeded PRNG
LCG: `s = (s * 1664525 + 1013904223) >>> 0`, normalized to [0, 1).

## Open
- Non-deterministic components (random content) may create many spurious states; 200-node limit prevents runaway
- Link clicks that navigate away from the page will break subsequent exploration
- Closed shadow DOM is inaccessible (inherited limitation from M3)
