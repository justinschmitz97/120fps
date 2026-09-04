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

// A pattern the budget cut short, or one of whose steps threw, does not end
// where it started, so the state-invariance proof does not cover the state
// it left. The next sample replays the path instead of measuring from that
// state. `executeStressPattern` swallows a throwing step and still counts it
// as run, so `stepsFailed` is the only signal for that case.
function patternRanShort(run: StressPatternRun | undefined): boolean {
  if (!run) return false;
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

// --- Work queue ---

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
  // Only for the degrade warning's wording — a reader needs to know
  // which combo stopped exploring.
  comboIndex: number;
}

// Thrown by the retried body when the explore budget runs out mid-retry.
// `withFrameStarvationRetry` does not classify it as a stall, so it
// propagates out of the retry loop unretried; the call site catches this
// type and only this type, which is what turns "budget gone" into a degrade
// instead of a crash. The combo keeps whatever it explored.
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

  // Warmup and initial state share the retry: a reload here loses the whole
  // combo, not one sample, so it is the costliest place to be unprotected.
  const { initialHash, initialInteractions, volatile } = await withContextRetry(
    enter,
    async () => {
      for (let w = 0; w < opts.warmupRuns; w++) {
        await mountComponent(page, props);
      }

      await mountComponent(page, props);
      // Measure the DOM's own noise floor before attributing any change to
      // an interaction. Runs before discovery so every hash in this combo,
      // including the initial one, speaks the same language.
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

  // One clock for the whole combo. The stress pattern reads what
  // is left of it so a pattern whose every click times out cannot outlive the
  // budget that bounds it.
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

    // Resolve stress pattern for this interaction
    const siblings = await findAriaGroupSiblings(page, item.interaction);
    const pattern = resolveStressPattern(item.interaction, siblings);

    // Collect N timing samples
    const samples: number[] = [];
    const traces: TraceEvent[][] = [];
    let targetHash: string | null = null;
    // What the pattern actually did on the last sample. Both
    // bodies below write it, so a truncated run reaches the edge instead of
    // being discarded at the call site.
    let patternRun: StressPatternRun | undefined;

    // A state-invariant pattern ends where it started (the same proof that
    // makes this edge a self-loop below), so samples 2..N already stand in
    // the state the path leads to. Replaying it per sample would cost
    // (depth+1) double-rAF fences on the vsync context for a state that did
    // not change. The flag is per pattern, so an edge whose pattern is not
    // state-invariant keeps replaying per sample.
    let pathIsCurrent = false;
    const replayPath = async (): Promise<void> => {
      if (pattern.stateInvariant && pathIsCurrent) return;
      await navigateToState(page, props, sourceNode.pathFromRoot);
      pathIsCurrent = true;
    };
    // Both retry layers re-enter the harness before they run the body
    // again, which unmounts whatever the previous sample left. The next sample
    // is measured from a replayed path, never from what a retry destroyed.
    const enterAndInvalidatePath = async (): Promise<void> => {
      pathIsCurrent = false;
      await enter();
    };

    for (let s = 0; s < opts.sampleCount; s++) {
      if (Date.now() - startTime >= opts.maxWallClockMs) break;

      // The same exercise, timed two ways. The observer path skips the
      // per-sample trace lifecycle, which is what dominates explore's wall
      // clock; the trace path stays the default until the A/B says otherwise.
      if (opts.observerTiming) {
        // The same degrade the trace path gets. This path cannot stall on
        // tracing (it starts none), but a `Target closed` still classifies as
        // a stall, so it is caught here rather than ending the whole run.
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

      // The same bounded retry the mount and rerender sample loops already
      // compose around their own bodies. A `tracing-timeout` is one of the
      // stalls it classifies, catching a stall here degrades this combo
      // instead of ending the whole run.
      // The two retry layers are not disjoint -- `CONTEXT_LOST` matches the
      // same `tracing-timeout` and `Target closed` signatures `classifyStall`
      // recovers from, so nesting them would multiply the attempts (5 traced
      // actions per stalled sample, each bounded only by the 60 s trace
      // flush timeout). The inner layer gets no budget on this path: the
      // outer one owns the retry, and the wall clock is re-checked before
      // every attempt so the phase cannot outlive the budget it printed.
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
                // Zero inner retries. The outer layer owns the retry for
                // the two signatures both layers recognize, so the attempt
                // count is `MAX_FRAME_STARVATION_RETRIES + 1`, not its square.
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
        // The partially sampled edge below is still pushed whenever any
        // sample survived, so the count has to include it.
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
        // A state-invariant pattern ends where it started, so the edge is
        // a self-loop. Hashing the DOM here would mint one node per scroll
        // offset as virtualized windowing rewrites the rows.
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

      // Navigate to target state to discover its interactions
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
