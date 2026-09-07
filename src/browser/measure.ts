import path from "node:path";
import type { CDPSession, Page } from "playwright";
import type { HarnessResult } from "../harness/index.js";
import type { PropCombination } from "../props/index.js";
import { extractProps, generateCombinations, FUNCTION_MARKER, serializeProps } from "../props/index.js";
import {
  hasPageErrors,
  mergeDrains,
  type PageErrorCapture,
  type PageErrorDrain,
} from "./page-errors.js";
import {
  beginMutationWatch,
  classifyMeasuredState,
  collectUnresolvedSpriteRefs,
  countComponentNodes,
  detectAnimations,
  endMutationWatch,
  MEASURED_STATE_HOLD_MS,
  readNetworkProbe,
  totalComponentNodes,
  type MeasuredState,
} from "./dom.js";
import {
  createPhaseTracker,
  enterHarness,
  openMeasurementSession,
  refreshCdpSession,
  suspendThrottle,
  tryCollectGarbage,
  type MeasurementSession,
} from "./session.js";
import {
  createRetryBudget,
  withContextRetry,
  withFrameStarvationRetry,
  withWarmupRetry,
} from "./retry.js";
import {
  buildTimingResult,
  collectTrace,
  nextComboIndex,
  parseTraceDuration,
  type MeasureOptions,
  type MeasureRerenderOptions,
  type MountResult,
  type RerenderResult,
  type TraceEvent,
  type TransitionWindow,
} from "./trace.js";
import { computeMedian } from "../shared/index.js";

// Read from the page: the wrapper may import browser-only packages, so Node cannot evaluate it.
export async function applyWrapperViewport(page: Page): Promise<void> {
  const viewport = await page.evaluate(
    () => (window as any).__120fps?.viewport as { width?: unknown; height?: unknown } | undefined,
  );
  if (!viewport) return;
  const { width, height } = viewport;
  if (typeof width !== "number" || typeof height !== "number") return;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return;
  await page.setViewportSize({ width: Math.round(width), height: Math.round(height) });
}

// Under begin-frame control a hung fence means a dead pump, never a slow component.
const RAF_FENCE_TIMEOUT_MS = 10_000;

export async function rafFence(page: Page): Promise<void> {
  await page.evaluate(
    (timeoutMs: number) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error(`frame starvation: rAF fence exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            clearTimeout(t);
            resolve();
          }),
        );
      }),
    RAF_FENCE_TIMEOUT_MS,
  );
}

// `withFrameStarvationRetry` bounds one combo; a wedged page starves every combo after it.
export const MAX_CONSECUTIVE_DEGRADED_COMBOS = 3;

// Result arrays keep their holes so positional consumers line up; iterators filter here.
export function measuredOnly<T>(results: T[]): NonNullable<T>[] {
  return results.filter((r): r is NonNullable<T> => r !== undefined && r !== null);
}

export const measurementAbandonedWarning = (
  phase: "mount" | "rerender",
  degraded: number,
  skipped: number,
): string =>
  `${phase}: ${degraded} combos in a row produced no measurement after their retries; ` +
  `skipped the remaining ${skipped} of this pass and kept what was measured. ` +
  "The page stopped answering, so measuring further combos on it would spend the run's budget for nothing.";

export interface DegradedPassBound {
  // `true` once this pass has to stop; the caller breaks out of its combo loop.
  degraded(position: number): boolean;
  measured(): void;
}

export function createDegradedPassBound(
  phase: "mount" | "rerender",
  total: number,
  onWarning?: (warning: string) => void,
): DegradedPassBound {
  let run = 0;
  return {
    degraded(position: number): boolean {
      run++;
      if (run < MAX_CONSECUTIVE_DEGRADED_COMBOS) return false;
      // A bound tripping on the pass's last combo skipped nothing, so a warning would be noise.
      const skipped = total - position - 1;
      if (skipped > 0) onWarning?.(measurementAbandonedWarning(phase, run, skipped));
      return true;
    },
    measured(): void {
      run = 0;
    },
  };
}

export interface WrapperOverhead {
  overheadMs: number;
  domNodes: number;
  // Read from the page: only the control API knows the export was a callable setup.
  hasSetup: boolean;
}

const WRAPPER_OVERHEAD_WARMUP = 2;

export async function measureWrapperOverhead(
  page: Page,
  cdp: CDPSession,
  samples: number,
): Promise<WrapperOverhead> {
  const mountWrapper = async () => {
    await page.evaluate(() => (window as any).__120fps.mountWrapperOnly());
    await rafFence(page);
  };
  const unmount = () => page.evaluate(() => (window as any).__120fps.unmount());
  const countNodes = async () => totalComponentNodes(await countComponentNodes(page));

  for (let w = 0; w < WRAPPER_OVERHEAD_WARMUP; w++) {
    await mountWrapper();
    await unmount();
  }

  const durations: number[] = [];
  let wrapperNodes = 0;
  let emptyNodes = 0;

  for (let s = 0; s < samples; s++) {
    await tryCollectGarbage(cdp);
    const events = await collectTrace(cdp, mountWrapper);
    durations.push(parseTraceDuration(events).totalDuration);
    if (s === 0) wrapperNodes = await countNodes();
    await unmount();
    if (s === 0) emptyNodes = await countNodes();
  }

  return {
    overheadMs: computeMedian(durations),
    domNodes: Math.max(0, wrapperNodes - emptyNodes),
    hasSetup: await page.evaluate(() => (window as any).__120fps?.hasSetup === true),
  };
}

// The first combo pays process-level JIT warmup, later ones only a cold start; 0 stays 0.
export function warmupsForPosition(position: number, warmupRuns: number): number {
  return position === 0 ? warmupRuns : Math.min(1, warmupRuns);
}

async function traceMount(
  page: Page,
  cdp: CDPSession,
  props: PropCombination,
): Promise<TraceEvent[]> {
  await page.evaluate(() => (window as any).__120fps.unmount());

  const safeProps = serializeProps(props);
  return collectTrace(cdp, async () => {
    await page.evaluate(
      ([p, marker]: [any, string]) => {
        for (const k of Object.keys(p)) {
          if (p[k] === marker) p[k] = () => {};
        }
        (window as any).__120fps.mount(p);
      },
      [safeProps, FUNCTION_MARKER] as [Record<string, unknown>, string],
    );
    await rafFence(page);
  });
}

// Mount cost alone, with teardown outside the traced window.
export async function mountAndTrace(
  page: Page,
  cdp: CDPSession,
  props: PropCombination,
): Promise<number> {
  return parseTraceDuration(await traceMount(page, cdp, props)).totalDuration;
}

// Per-combo facts: reading them per sample would pay a getComputedStyle sweep under throttle.
export async function runMountUnmount(
  page: Page,
  cdp: CDPSession,
  props: PropCombination,
  collectDomInfo: boolean,
): Promise<{
  mountDur: number;
  unmountDur: number;
  domNodeCount: number;
  // The portal half of `domNodeCount`.
  orphanNodes: number;
  // Same-document sprite ids nothing in the page defines.
  unresolvedSpriteRefs: string[];
  hasAnimation: boolean;
  measuredState: MeasuredState;
  mountEvents: TraceEvent[];
}> {
  const netBefore = collectDomInfo ? await readNetworkProbe(page) : undefined;

  const mountEvents = await traceMount(page, cdp, props);

  // Armed first: the probes below cost real time, and content arriving then is the component's.
  if (collectDomInfo) await beginMutationWatch(page);

  const nodeCount = collectDomInfo
    ? await countComponentNodes(page)
    : { rootNodes: 0, orphanNodes: 0 };
  const domNodeCount = totalComponentNodes(nodeCount);

  // Same between-traces window as the node count, so no traced sample pays for it.
  const unresolvedSpriteRefs = collectDomInfo ? await collectUnresolvedSpriteRefs(page) : [];

  const hasAnimation = collectDomInfo ? await detectAnimations(page) : false;

  let measuredState: MeasuredState = "settled";
  if (collectDomInfo) {
    const mutated = await endMutationWatch(page, MEASURED_STATE_HOLD_MS);
    const netAfter = await readNetworkProbe(page);
    measuredState = classifyMeasuredState({
      pendingNetwork: netAfter.pending.some((id) => id > (netBefore?.started ?? 0)),
      mutated,
      hasAnimation,
    });
  }

  const mountParsed = parseTraceDuration(mountEvents);

  const unmountEvents = await collectTrace(cdp, async () => {
    await page.evaluate(() => (window as any).__120fps.unmount());
    await rafFence(page);
  });

  const unmountParsed = parseTraceDuration(unmountEvents);

  return {
    mountDur: mountParsed.totalDuration,
    unmountDur: unmountParsed.totalDuration,
    domNodeCount,
    orphanNodes: nodeCount.orphanNodes,
    unresolvedSpriteRefs,
    hasAnimation,
    measuredState,
    mountEvents,
  };
}

// The combo's own error window closes before the transition's opens, or errors cross over.
export async function runWithSplitErrorWindows(
  capture: Pick<PageErrorCapture, "drain">,
  result: RerenderResult,
  transition: TransitionWindow | undefined,
): Promise<RerenderResult> {
  let own = capture.drain();
  if (hasPageErrors(own)) result.pageErrors = own;
  if (!transition) return result;
  // The seam lets a transition body reclaim the combo's window for a sub-step it can prove.
  const claimOwnWindow = (): void => {
    const drained = capture.drain();
    if (!hasPageErrors(drained)) return;
    own = mergeDrains(own, drained) ?? drained;
    result.pageErrors = own;
  };
  await transition.run(claimOwnWindow);
  const drained = capture.drain();
  if (hasPageErrors(drained)) {
    result.transitionPageErrors = { toComboIndex: transition.toComboIndex, errors: drained };
  }
  return result;
}

export async function mountAndWait(page: Page, props: PropCombination): Promise<void> {
  await page.evaluate(() => (window as any).__120fps.unmount());
  const safeProps = serializeProps(props);
  await page.evaluate(
    ([p, marker]: [any, string]) => {
      for (const k of Object.keys(p)) {
        if (p[k] === marker) p[k] = () => {};
      }
      (window as any).__120fps.mount(p);
    },
    [safeProps, FUNCTION_MARKER] as [Record<string, unknown>, string],
  );
  await rafFence(page);
}

export async function rerenderAndTrace(
  page: Page,
  cdp: CDPSession,
  props: PropCombination,
): Promise<number> {
  const safeProps = serializeProps(props);
  const events = await collectTrace(cdp, async () => {
    await page.evaluate(
      ([p, marker]: [any, string]) => {
        for (const k of Object.keys(p)) {
          if (p[k] === marker) p[k] = () => {};
        }
        (window as any).__120fps.rerender(p);
      },
      [safeProps, FUNCTION_MARKER] as [Record<string, unknown>, string],
    );
    await rafFence(page);
  });
  return parseTraceDuration(events).totalDuration;
}

export async function measureRerender(
  harness: HarnessResult,
  options: MeasureRerenderOptions = {},
): Promise<RerenderResult[]> {
  const {
    samples: sampleCount = 10,
    cpuThrottle = 4,
    warmupRuns = 2,
  } = options;

  let combos: PropCombination[];
  if (options.combos) {
    combos = options.combos;
  } else {
    const schemas = await extractProps(harness.componentPath);
    combos = generateCombinations(schemas);
    if (combos.length === 0) combos = [{}];
  }

  const animated = new Set(options.animatedComboIndices ?? []);
  const drivenIndices: number[] = [];
  const vsyncIndices: number[] = [];
  combos.forEach((_, i) => (animated.has(i) ? vsyncIndices : drivenIndices).push(i));

  const results: RerenderResult[] = new Array(combos.length);
  const inFlight = createPhaseTracker("rerender", harness);

  const runPass = async (ms: MeasurementSession, indices: number[]) => {
    const enter = async () => {
      await refreshCdpSession(ms.page, ms.session);
      await enterHarness(ms.page, ms.session.cdp, harness, ms.errorCapture, {
        label: "rerender harness",
        cpuThrottle,
        onWarning: options.onWarning,
      });
    };
    await enter();
    const retryBudget = createRetryBudget();
    // A wedged page starves every combo that follows, so the pass carries its own bound.
    const passBound = createDegradedPassBound("rerender", indices.length, options.onWarning);

    for (const [position, ci] of indices.entries()) {
      inFlight.combo = ci;
      const props = combos[ci];

      // Guarded like the sample loops: an unretried warmup stall would fail the whole pass.
      const warmups = warmupsForPosition(position, warmupRuns);
      if (warmups > 0) {
        const warmed = await withWarmupRetry(
          ci,
          enter,
          async () => {
            await mountAndWait(ms.page, props);
            for (let w = 0; w < warmups; w++) {
              await rerenderAndTrace(ms.page, ms.session.cdp, props);
            }
          },
          retryBudget,
          options.onWarning,
        );
        if (!warmed) {
          ms.errorCapture.drain();
          if (passBound.degraded(position)) break;
          continue;
        }
      }

      // A sample that still starves after the bounded retries is omitted, never thrown.
      const stableSamples: number[] = [];
      for (let s = 0; s < sampleCount; s++) {
        const sample = await withFrameStarvationRetry(
          ci,
          enter,
          () =>
            withContextRetry(
              enter,
              async () => {
                await suspendThrottle(ms.session.cdp, cpuThrottle, () => tryCollectGarbage(ms.session.cdp));
                await mountAndWait(ms.page, props);
                return rerenderAndTrace(ms.page, ms.session.cdp, props);
              },
              { onRetry: options.onWarning, budget: retryBudget },
            ),
          options.onWarning,
        );
        if (sample !== undefined) stableSamples.push(sample);
      }

      // A combo nothing measured is omitted, never reported as a misleading all-zero timing.
      if (stableSamples.length === 0) {
        // It still opened an error window; undrained, its errors land on the next combo.
        ms.errorCapture.drain();
        if (passBound.degraded(position)) break;
        continue;
      }
      passBound.measured();

      const result: RerenderResult = {
        comboIndex: ci,
        props,
        stable: buildTimingResult(stableSamples),
        pacing: ms.pacing,
      };

      let transition: TransitionWindow | undefined;
      if (combos.length > 1) {
        // Follows the full combo list, so partitioning by pacing cannot change the pairing.
        const nextIndex = nextComboIndex(ci, combos.length);
        const nextProps = combos[nextIndex];
        // Cross-scale rerenders are not meaningful, so either side being scale skips this.
        const isScale = "__120fps_scaleN" in props;
        const nextIsScale = "__120fps_scaleN" in nextProps;
        if (!isScale && !nextIsScale) {
          transition = {
            toComboIndex: nextIndex,
            run: async () => {
              const changeSamples: number[] = [];
              for (let s = 0; s < sampleCount; s++) {
                const sample = await withFrameStarvationRetry(
                  ci,
                  enter,
                  () =>
                    withContextRetry(
                      enter,
                      async () => {
                        await suspendThrottle(ms.session.cdp, cpuThrottle, () => tryCollectGarbage(ms.session.cdp));
                        // Lands on the previous rerender's state: a transition artefact.
                        await mountAndWait(ms.page, props);
                        return rerenderAndTrace(ms.page, ms.session.cdp, nextProps);
                      },
                      { onRetry: options.onWarning, budget: retryBudget },
                    ),
                  options.onWarning,
                );
                if (sample !== undefined) changeSamples.push(sample);
              }
              if (changeSamples.length > 0) {
                result.change = buildTimingResult(changeSamples);
                result.changeToProps = nextProps;
              }
            },
          };
        }
      }

      // Two windows: this combo's own renders, then the rerender into the next combo's props.
      await runWithSplitErrorWindows(ms.errorCapture, result, transition);

      results[ci] = result;
    }
  };

  if (drivenIndices.length > 0) {
    const ms = await openMeasurementSession({ driven: true, onWarning: options.onWarning, pool: options.pool, harnessDirName: path.basename(harness.harnessDir) });
    try {
      await inFlight.run(() => runPass(ms, drivenIndices));
    } finally {
      await ms.close();
    }
  }
  if (vsyncIndices.length > 0) {
    const ms = await openMeasurementSession({ driven: false, onWarning: options.onWarning, pool: options.pool, harnessDirName: path.basename(harness.harnessDir) });
    try {
      await inFlight.run(() => runPass(ms, vsyncIndices));
    } finally {
      await ms.close();
    }
  }

  return results;
}

// Consulted after each combo finishes, so a gate that needs a measurement can refuse the rest of
// the batch without opening a second session.
export interface MountPassGate {
  shouldContinue(afterComboIndex: number, results: readonly (MountResult | undefined)[]): boolean;
}

export async function measureMount(
  harness: HarnessResult,
  options: MeasureOptions & { gate?: MountPassGate } = {},
): Promise<MountResult[]> {
  const {
    samples: sampleCount = 10,
    cpuThrottle = 4,
    warmupRuns = 2,
  } = options;

  let combos: PropCombination[];
  if (options.combos) {
    combos = options.combos;
  } else {
    const schemas = await extractProps(harness.componentPath);
    combos = generateCombinations(schemas);
    if (combos.length === 0) combos = [{}];
  }

  const results: MountResult[] = new Array(combos.length);
  // Animation cost is time-based, so driven frames change how much lands in a traced window.
  const vsyncQueue: number[] = [];

  // Tracked so a preamble failure reports the phase alone and a combo failure adds the combo.
  const inFlight = createPhaseTracker("mount", harness);
  // Errors the driven attempt saw before bailing; merged into the re-measurement's result.
  const carriedErrors = new Map<number, PageErrorDrain | undefined>();

  const runPass = async (
    ms: MeasurementSession,
    indices: number[],
    bailOnAnimation: boolean,
  ) => {
    const enter = async () => {
      await refreshCdpSession(ms.page, ms.session);
      await enterHarness(ms.page, ms.session.cdp, harness, ms.errorCapture, {
        label: "mount harness",
        cpuThrottle,
        onWarning: options.onWarning,
      });
    };
    await enter();
    const retryBudget = createRetryBudget();
    const passBound = createDegradedPassBound("mount", indices.length, options.onWarning);

    for (const [position, ci] of indices.entries()) {
      // Read before the combo rather than after the previous one, so every path out of the body
      // below — a vsync bail, a combo nothing measured — reaches the gate just the same.
      if (position > 0 && options.gate && !options.gate.shouldContinue(indices[position - 1], results)) {
        break;
      }
      inFlight.combo = ci;
      const props = combos[ci];

      // Guarded like the sample loop: an unretried warmup stall would fail the whole pass.
      const warmupCount = warmupsForPosition(position, warmupRuns);
      if (warmupCount > 0) {
        const warmed = await withWarmupRetry(
          ci,
          enter,
          async () => {
            for (let w = 0; w < warmupCount; w++) {
              await runMountUnmount(ms.page, ms.session.cdp, props, false);
            }
          },
          retryBudget,
          options.onWarning,
        );
        if (!warmed) {
          ms.errorCapture.drain();
          if (passBound.degraded(position)) break;
          continue;
        }
      }

      const mountSamples: number[] = [];
      const unmountSamples: number[] = [];
      const mountTraces: TraceEvent[][] = [];
      let domNodeCount = 0;
      let orphanNodes = 0;
      let unresolvedSpriteRefs: string[] = [];
      let hasAnimation = false;
      let measuredState: MeasuredState = "settled";
      let bailed = false;

      let heapBefore = 0;
      try {
        const pre = await ms.session.cdp.send("Runtime.getHeapUsage" as any) as { usedSize: number };
        heapBefore = pre.usedSize;
      } catch { /* CDP method may not be available */ }

      // A sample that still starves after the bounded retries is skipped, never thrown.
      for (let s = 0; s < sampleCount; s++) {
        const run = await withFrameStarvationRetry(
          ci,
          enter,
          () =>
            withContextRetry(
              enter,
              async () => {
                await suspendThrottle(ms.session.cdp, cpuThrottle, () => tryCollectGarbage(ms.session.cdp));
                return runMountUnmount(ms.page, ms.session.cdp, props, s === 0);
              },
              { onRetry: options.onWarning, budget: retryBudget },
            ),
          options.onWarning,
        );
        if (run === undefined) continue;
        if (s === 0 && bailOnAnimation && run.hasAnimation) {
          vsyncQueue.push(ci);
          bailed = true;
          break;
        }
        mountSamples.push(run.mountDur);
        unmountSamples.push(run.unmountDur);
        mountTraces.push(run.mountEvents);
        if (s === 0) {
          domNodeCount = run.domNodeCount;
          orphanNodes = run.orphanNodes;
          unresolvedSpriteRefs = run.unresolvedSpriteRefs;
          hasAnimation = run.hasAnimation;
          measuredState = run.measuredState;
        }
      }
      // A combo that bails to the vsync queue keeps what the driven attempt saw.
      const drained = ms.errorCapture.drain();
      if (bailed) {
        carriedErrors.set(ci, mergeDrains(carriedErrors.get(ci), drained));
        continue;
      }
      // A combo nothing measured is omitted, never reported as an all-zero mount.
      if (mountSamples.length === 0) {
        if (passBound.degraded(position)) break;
        continue;
      }
      passBound.measured();
      const pageErrors = mergeDrains(carriedErrors.get(ci), drained);

      let heapDelta = 0;
      try {
        const post = await ms.session.cdp.send("Runtime.getHeapUsage" as any) as { usedSize: number };
        heapDelta = post.usedSize - heapBefore;
      } catch { /* fall back to 0 */ }

      results[ci] = {
        comboIndex: ci,
        props,
        mount: buildTimingResult(mountSamples),
        unmount: buildTimingResult(unmountSamples),
        domNodeCount,
        heapDelta,
        hasAnimation,
        measuredState,
        mountTraces,
        pacing: ms.pacing,
        ...(hasPageErrors(pageErrors) ? { pageErrors: pageErrors! } : {}),
        // Absent when there is nothing to say, so a portal-free component reports as before.
        ...(orphanNodes > 0 ? { orphanNodes } : {}),
        ...(unresolvedSpriteRefs.length > 0 ? { unresolvedSpriteRefs } : {}),
      };
    }
  };

  const driven = await openMeasurementSession({ driven: true, onWarning: options.onWarning, pool: options.pool, harnessDirName: path.basename(harness.harnessDir) });
  try {
    await inFlight.run(() =>
      runPass(
        driven,
        combos.map((_, i) => i),
        // A probe fallback already runs the whole pass under vsync: nothing to bail to.
        driven.pacing === "driven",
      ),
    );
  } finally {
    await driven.close();
  }

  if (vsyncQueue.length > 0) {
    const vs = await openMeasurementSession({ driven: false, onWarning: options.onWarning, pool: options.pool, harnessDirName: path.basename(harness.harnessDir) });
    try {
      await inFlight.run(() => runPass(vs, vsyncQueue, false));
    } finally {
      await vs.close();
    }
  }

  return results;
}
