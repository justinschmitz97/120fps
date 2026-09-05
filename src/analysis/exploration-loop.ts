import type { Page } from "playwright";
import type { PropCombination } from "../props/index.js";
import type { InteractionDescriptor } from "../browser/index.js";
import {
  createRng,
  mountComponent,
  computeDomHash,
  exerciseInteraction,
  navigateToState,
  probeVolatileRegions,
  type StateGraph,
  type StateNode,
  type StateEdge,
} from "./explorer.js";
import {
  discoverInteractions,
  withContextRetry,
  withFrameStarvationRetry,
  suspendThrottle,
  tryCollectGarbage,
  installObservers,
  beginObservedWindow,
  readObservedWindow,
  observedInteractionMs,
  createRetryBudget,
  collectTrace,
  parseTraceDuration,
  type CdpHolder,
  type RetryBudget,
  type TraceEvent,
} from "../browser/index.js";
import {
  resolveStressPattern,
  executeStressPattern,
  findAriaGroupSiblings,
  countPatternEvents,
  type StressPatternRun,
} from "./stress-patterns.js";
import { computeMedian, computeP95 } from "../shared/index.js";

function shuffleArray<T>(arr: T[], rng: () => number): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// A pattern that ran short did not end where it started, so the cached path is invalid.
function patternRanShort(run: StressPatternRun | undefined): boolean {
  if (!run) return false;
  // stepsFailed: executeStressPattern swallows a throwing step and still counts it as run.
  return run.budgetExhausted || run.stepsRun < run.stepsPlanned || run.stepsFailed > 0;
}

function computeGlobalMedianEdgeCost(edges: StateEdge[]): number {
  if (edges.length === 0) return 0;
  const medians = edges.map((e) => e.median);
  const sorted = [...medians].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

interface WorkItem {
  stateId: string;
  interaction: InteractionDescriptor;
  depth: number;
}

interface InternalOptions {
  sampleCount: number;
  maxNodes: number;
  maxWallClockMs: number;
  maxDepth: number;
  warmupRuns: number;
  seed: number;
  cpuThrottle: number;
  observerTiming: boolean;
  // Only the degrade warning uses it: the reader needs to know which combo stopped exploring.
  comboIndex: number;
}

// Not classified as a stall, so it propagates unretried and the call site degrades the combo.
class ExploreBudgetSpent extends Error {
  constructor() {
    super("explore wall-clock budget spent");
  }
}

export const EXPLORE_STALLED_WARNING = (comboIndex: number, edgeCount: number): string =>
  `combo ${comboIndex}: explore skipped (tracing stalled); ${edgeCount} interaction` +
  `${edgeCount === 1 ? "" : "s"} measured before the stall are kept and the report still prints`;

export async function exploreCombo(
  page: Page,
  session: CdpHolder,
  props: PropCombination,
  opts: InternalOptions,
  enter: () => Promise<void>,
  onWarning?: (warning: string) => void,
  budget?: RetryBudget,
): Promise<StateGraph> {
  const rng = createRng(opts.seed);
  const startTime = Date.now();
  const nodes = new Map<string, StateNode>();
  const edges: StateEdge[] = [];
  const exploredEdges = new Set<string>();
  const convergenceWindow: boolean[] = [];
  const CONVERGENCE_SIZE = 10;

  // Warmup and initial state share the retry: a reload here loses the whole combo, not a sample.
  const { initialHash, initialInteractions, volatile } = await withContextRetry(
    enter,
    async () => {
      for (let w = 0; w < opts.warmupRuns; w++) {
        await mountComponent(page, props);
      }

      await mountComponent(page, props);
      // Must run before discovery, so every hash in this combo excludes the same volatile paths.
      const volatile = await probeVolatileRegions(page);
      const hash = await computeDomHash(page, volatile);
      const interactions = await discoverInteractions(page, {
        probePortals: true,
        remount: () => mountComponent(page, props),
      });
      return { initialHash: hash, initialInteractions: interactions, volatile };
    },
    { onRetry: onWarning, budget },
  );

  nodes.set(initialHash, {
    id: initialHash,
    depth: 0,
    interactions: initialInteractions,
    pathFromRoot: [],
  });

  // Work queues: priority (expensive path follow-ups) and normal (BFS)
  const priorityQueue: WorkItem[] = [];
  const normalQueue: WorkItem[] = [];

  const shuffled = shuffleArray(initialInteractions, rng);
  for (const interaction of shuffled) {
    normalQueue.push({ stateId: initialHash, interaction, depth: 0 });
  }

  // One clock for the whole combo: a pattern whose every click times out cannot outlive it.
  const remainingWallClock = (): number =>
    Math.max(0, opts.maxWallClockMs - (Date.now() - startTime));
  let stalled = false;

  while (priorityQueue.length > 0 || normalQueue.length > 0) {
    if (stalled) break;
    if (Date.now() - startTime >= opts.maxWallClockMs) break;
    if (nodes.size >= opts.maxNodes) break;

    if (convergenceWindow.length >= CONVERGENCE_SIZE) {
      const recent = convergenceWindow.slice(-CONVERGENCE_SIZE);
      if (recent.every((g) => !g)) break;
    }

    const item =
      priorityQueue.length > 0
        ? priorityQueue.shift()!
        : normalQueue.shift()!;

    const sourceNode = nodes.get(item.stateId);
    if (!sourceNode) continue;

    const edgeKey = `${item.stateId}:${item.interaction.selector}:${item.interaction.type}`;
    if (exploredEdges.has(edgeKey)) continue;
    exploredEdges.add(edgeKey);

    const siblings = await findAriaGroupSiblings(page, item.interaction);
    const pattern = resolveStressPattern(item.interaction, siblings);

    const samples: number[] = [];
    const traces: TraceEvent[][] = [];
    let targetHash: string | null = null;
    // Both bodies below write it, so a truncated run reaches the edge instead of being discarded.
    let patternRun: StressPatternRun | undefined;

    // A state-invariant pattern ends where it started; replaying its path per sample buys nothing.
    let pathIsCurrent = false;
    const replayPath = async (): Promise<void> => {
      if (pattern.stateInvariant && pathIsCurrent) return;
      await navigateToState(page, props, sourceNode.pathFromRoot);
      pathIsCurrent = true;
    };
    // Both retry layers re-enter the harness, which unmounts whatever the previous sample left.
    const enterAndInvalidatePath = async (): Promise<void> => {
      pathIsCurrent = false;
      await enter();
    };

    for (let s = 0; s < opts.sampleCount; s++) {
      if (Date.now() - startTime >= opts.maxWallClockMs) break;

      // The observer path skips the per-sample trace lifecycle, which dominates the wall clock.
      if (opts.observerTiming) {
        // A "Target closed" still classifies as a stall, though this path starts no tracing.
        let observed: Awaited<ReturnType<typeof readObservedWindow>> | undefined;
        if (remainingWallClock() > 0) {
          try {
            observed = await withFrameStarvationRetry(
              opts.comboIndex,
              enterAndInvalidatePath,
              () => {
                if (remainingWallClock() <= 0) throw new ExploreBudgetSpent();
                return withContextRetry(
                  enterAndInvalidatePath,
                  async () => {
                    await suspendThrottle(session.cdp, opts.cpuThrottle, () => tryCollectGarbage(session.cdp));
                    await replayPath();
                    await installObservers(page);
                    await beginObservedWindow(page);
                    patternRun = await executeStressPattern(page, pattern, remainingWallClock());
                    return readObservedWindow(page);
                  },
                  { onRetry: onWarning, budget: createRetryBudget(0) },
                );
              },
              onWarning,
            );
          } catch (err) {
            if (!(err instanceof ExploreBudgetSpent)) throw err;
          }
        }
        if (observed === undefined) {
          const kept = edges.length + (samples.length > 0 ? 1 : 0);
          onWarning?.(EXPLORE_STALLED_WARNING(opts.comboIndex, kept));
          stalled = true;
          break;
        }
        samples.push(observedInteractionMs(observed));
        if (patternRanShort(patternRun)) pathIsCurrent = false;
        traces.push([]);
        if (s === 0) {
          targetHash = pattern.stateInvariant ? item.stateId : await computeDomHash(page, volatile);
        }
        continue;
      }

      // A tracing-timeout classifies as a stall, so catching it degrades the combo, not the run.
      let traceEvents: TraceEvent[] | undefined;
      if (remainingWallClock() > 0) {
        try {
          traceEvents = await withFrameStarvationRetry(
            opts.comboIndex,
            enterAndInvalidatePath,
            () => {
              if (remainingWallClock() <= 0) throw new ExploreBudgetSpent();
              return withContextRetry(
                enterAndInvalidatePath,
                async () => {
                  await suspendThrottle(session.cdp, opts.cpuThrottle, () => tryCollectGarbage(session.cdp));
                  await replayPath();
                  return collectTrace(session.cdp, async () => {
                    patternRun = await executeStressPattern(page, pattern, remainingWallClock());
                  });
                },
                // Zero inner retries: the outer layer owns both shared signatures, so attempts add.
                { onRetry: onWarning, budget: createRetryBudget(0) },
              );
            },
            onWarning,
          );
        } catch (err) {
          if (!(err instanceof ExploreBudgetSpent)) throw err;
        }
      }
      if (traceEvents === undefined) {
        // The partially sampled edge below is still pushed whenever any sample survived.
        const kept = edges.length + (samples.length > 0 ? 1 : 0);
        onWarning?.(EXPLORE_STALLED_WARNING(opts.comboIndex, kept));
        stalled = true;
        break;
      }

      const parsed = parseTraceDuration(traceEvents);
      samples.push(parsed.totalDuration);
      if (patternRanShort(patternRun)) pathIsCurrent = false;
      traces.push(traceEvents);

      if (s === 0) {
        // A self-loop: hashing here would mint one node per scroll offset as windowing rewrites.
        targetHash = pattern.stateInvariant ? item.stateId : await computeDomHash(page, volatile);
      }
    }

    if (samples.length === 0 || targetHash === null) continue;

    const edgeId = `${item.stateId}->${targetHash}:${item.interaction.selector}`;
    const edge: StateEdge = {
      id: edgeId,
      fromId: item.stateId,
      toId: targetHash,
      interaction: item.interaction,
      samples,
      median: computeMedian(samples),
      p95: computeP95(samples),
      traces,
      stressPattern: pattern.name,
      stressSteps: patternRun ? patternRun.stepsRun : countPatternEvents(pattern),
      ...(patternRun?.budgetExhausted
        ? { stressTruncatedFrom: patternRun.stepsPlanned }
        : {}),
    };
    edges.push(edge);

    let discoveredNew = false;
    if (!nodes.has(targetHash)) {
      discoveredNew = true;

      const targetInteractions = await withContextRetry(
        enter,
        async () => {
          await navigateToState(page, props, sourceNode.pathFromRoot);
          await exerciseInteraction(page, item.interaction);
          return discoverInteractions(page);
        },
        { onRetry: onWarning, budget },
      );

      nodes.set(targetHash, {
        id: targetHash,
        depth: item.depth + 1,
        interactions: targetInteractions,
        pathFromRoot: [
          ...sourceNode.pathFromRoot,
          { interaction: item.interaction },
        ],
      });

      if (item.depth + 1 < opts.maxDepth) {
        const globalMedian = computeGlobalMedianEdgeCost(edges);
        const isExpensive = globalMedian > 0 && edge.p95 > 1.5 * globalMedian;
        const shuffledTarget = shuffleArray(targetInteractions, rng);

        for (const interaction of shuffledTarget) {
          const nextKey = `${targetHash}:${interaction.selector}:${interaction.type}`;
          if (!exploredEdges.has(nextKey)) {
            const wi: WorkItem = {
              stateId: targetHash,
              interaction,
              depth: item.depth + 1,
            };
            if (isExpensive) {
              priorityQueue.push(wi);
            } else {
              normalQueue.push(wi);
            }
          }
        }
      }
    }

    convergenceWindow.push(discoveredNew);
  }

  return {
    nodes,
    edges,
    initialNodeId: initialHash,
    wallClockMs: Date.now() - startTime,
    ...(volatile.length > 0 ? { volatilePaths: volatile } : {}),
  };
}
