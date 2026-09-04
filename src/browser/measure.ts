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

// Read from the page, not from Node: the wrapper module may import CSS and
// browser-only packages, so its `viewport` export only exists in the browser.
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

// A begin-frame-controlled browser produces no frames without the pump, so a
// hung fence means a dead pump, not a slow component. The watchdog turns that
// hang into a failed run instead of an infinite wait.
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

// M116 end-game fix-up (midday-F1): `withFrameStarvationRetry` bounds one
// combo; nothing bounded a pass. A renderer that wedges (an infinite render
// loop from one combo's props, a crashed target that re-enters into the same
// wedge) starves every combo that follows, so a delta pass of ~40 combos spent
// three bounded retries each and made no progress for the twenty minutes the
// run watchdog allows -- no report, no verdict. Three combos in a row that
// measured nothing is the signal that the page, not the combo, is what failed:
// the pass stops there and the run reports what it measured.
export const MAX_CONSECUTIVE_DEGRADED_COMBOS = 3;

// M116 end-game fix-up (midday-NEW1): both measurement passes keep one slot per
// combo (`new Array(combos.length)`) and leave the slot of a combo that measured
// nothing unset, so their result arrays are sparse. `for..of` yields `undefined`
// for a hole -- which is how the delta pass read `.props` of undefined and ended
// midday's run with a TypeError about the teardown instead of a report
// (`animatedIndices` in analyze.ts had already met the same holes and guarded
// with `m?.`). Positional consumers (`buildCurveReport`, report.ts) still need
// the holes to line up with their scale points, so the arrays keep them and
// every iterating consumer asks for the measured entries.
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
      // A bound that trips on the pass's last combo skipped nothing: the pass
      // reached its end, so warning about it would be noise.
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
  // M41: read from the page rather than parsed from the wrapper source: the
  // control API knows whether the export was actually a callable setup.
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

// A combo measured straight after a different combo pays that combo's cold
// start in its first sample. The first combo of a pass also absorbs the
// process-level JIT warmup; every later one needs a single render. 0 stays 0:
// an explicit opt-out is honoured.
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

// domNodeCount/hasAnimation/measuredState are read only when collectDomInfo is
// set: their values are per-combo facts, and reading them per sample paid a
// getComputedStyle sweep under the CPU throttle on every sample (M34). Every
// probe runs between traced windows, never inside one.
export async function runMountUnmount(
  page: Page,
  cdp: CDPSession,
  props: PropCombination,
  collectDomInfo: boolean,
): Promise<{
  mountDur: number;
  unmountDur: number;
  domNodeCount: number;
  // M106 B4: the portal half of `domNodeCount`.
  orphanNodes: number;
  // M106 B5: same-document sprite ids nothing in the page defines.
  unresolvedSpriteRefs: string[];
  hasAnimation: boolean;
  measuredState: MeasuredState;
  mountEvents: TraceEvent[];
}> {
  const netBefore = collectDomInfo ? await readNetworkProbe(page) : undefined;

  const mountEvents = await traceMount(page, cdp, props);

  // The watch is armed first: `countComponentNodes` and `detectAnimations` cost
  // real time under the throttle, and content arriving while they run belongs
  // to the component, not to a gap in our instrumentation.
  if (collectDomInfo) await beginMutationWatch(page);

  const nodeCount = collectDomInfo
    ? await countComponentNodes(page)
    : { rootNodes: 0, orphanNodes: 0 };
  const domNodeCount = totalComponentNodes(nodeCount);

  // M106 B5 (calcom-F5): read in the same between-traces window as the node
  // count, on the same `collectDomInfo` gate, so no traced sample pays for it.
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

// M99 (I4): the combo's own error window closes before any rerender into the
// next combo's props opens the transition's window. One window over both made
// an error the next combo's props raised read as this combo's own (V1: radix
// Label combos #1 and #6 carried a Slot error with no `asChild` of their own).
// The sequencing lives here so the attribution is verifiable without a browser.
export async function runWithSplitErrorWindows(
  capture: Pick<PageErrorCapture, "drain">,
  result: RerenderResult,
  transition: TransitionWindow | undefined,
): Promise<RerenderResult> {
  let own = capture.drain();
  if (hasPageErrors(own)) result.pageErrors = own;
  if (!transition) return result;
  // M99: a transition body may close the combo's own window again when it can
  // prove a sub-step belongs to the combo itself. The rerender pass does not
  // call it -- see the spec's Design note -- but the seam is what makes the
  // window boundary testable at all.
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
    // M116 end-game fix-up (midday-F1): the same pass-level bound the mount
    // pass carries -- a wedged page starves every combo that follows.
    const passBound = createDegradedPassBound("rerender", indices.length, options.onWarning);

    for (const [position, ci] of indices.entries()) {
      inFlight.combo = ci;
      const props = combos[ci];

      // Warmup on this combo's own props (results discarded, never recorded).
      // M89 (2): guarded by withWarmupRetry the same way the sample loops
      // below are — a starvation during warmup previously escaped retry
      // entirely and failed the whole pass instead of omitting just this
      // combo. An exhausted warmup omits the combo (its slot in `results`
      // stays unset) rather than propagating.
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

      // Stable rerender: mount with props, then rerender with same props N times.
      // M89: a frame-starvation failure retries (bounded) against a freshly
      // re-entered session; a sample that still starves after the bound is
      // omitted (not pushed), not thrown — the delta pass's extra rerender
      // calls are exactly where this fires (taxonomy's control).
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

      // Every sample for this combo starved out even after retrying: the
      // combo is omitted entirely (a disclosed partial result — the pass
      // continues to the rest of the combos) rather than reporting a
      // misleading all-zero timing for a combo nothing was actually measured
      // on.
      if (stableSamples.length === 0) {
        // M99 (review B-9): a combo nothing was measured on still opened an
        // error window. Leaving it undrained would attribute its errors to the
        // next combo's own window, the exact mis-attribution I4 exists to
        // prevent. The warmup path above already drains before its `continue`.
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

      // Prop-change rerender: mount with current props, rerender with next combo's props.
      // The pairing follows the full combo list, so partitioning by pacing
      // cannot change which combo rerenders into which.
      // Skip when either combo is a scale combo: cross-scale rerenders are not meaningful
      let transition: TransitionWindow | undefined;
      if (combos.length > 1) {
        const nextIndex = nextComboIndex(ci, combos.length);
        const nextProps = combos[nextIndex];
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
                        // M99: no own-window claim here. This mount lands on
                        // the page state the PREVIOUS sample's rerender left
                        // behind (combo ci+1's props), so an error it raises is
                        // a `ci+1 -> ci` transition artefact, not this combo's
                        // own. The whole delta-loop window is transition by
                        // construction; see the spec's Design note.
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

      // M99 (I4): two windows, not one — this combo's own renders, then the
      // rerender into `combos[ci+1]`'s props.
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

export async function measureMount(
  harness: HarnessResult,
  options: MeasureOptions = {},
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
  // Combos whose first sample detects a running animation: animation cost is
  // time-based, so driven frames change how much of it lands inside the traced
  // window. They are re-measured entirely under vsync pacing.
  const vsyncQueue: number[] = [];

  // M59: tracked rather than passed, so a failure in a pass preamble reports
  // the phase alone and one inside a combo reports the combo too.
  const inFlight = createPhaseTracker("mount", harness);
  // Errors seen by a combo's driven attempt before it bailed to the vsync
  // queue; merged into the result the re-measurement writes.
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
    // M116 end-game fix-up (midday-F1): combos that measured nothing, back to
    // back. Reset by any combo that measures.
    const passBound = createDegradedPassBound("mount", indices.length, options.onWarning);

    for (const [position, ci] of indices.entries()) {
      inFlight.combo = ci;
      const props = combos[ci];

      // Warmup: JIT + module cache stabilization, on this combo's own props
      // (results discarded, never recorded).
      // M89 (2): guarded by withWarmupRetry the same way the sample loop
      // below is — a starvation during warmup previously escaped retry
      // entirely and failed the whole pass instead of omitting just this
      // combo. An exhausted warmup omits the combo (its slot in `results`
      // stays unset) rather than propagating.
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

      // M89: a frame-starvation failure retries (bounded) against a freshly
      // re-entered session; a sample that still starves after the bound is
      // skipped, not thrown — the delta pass's own extra mount calls are one
      // of the two places this fires.
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
      // M59: closes this combo's window over the page's error stream. A combo
      // that bails to the vsync queue keeps what the driven attempt saw, so the
      // re-measurement adds to it rather than replacing it.
      const drained = ms.errorCapture.drain();
      if (bailed) {
        carriedErrors.set(ci, mergeDrains(carriedErrors.get(ci), drained));
        continue;
      }
      // M89: every sample for this combo starved out even after retrying —
      // omitted entirely (a disclosed partial result), not reported as an
      // all-zero mount that nothing was actually measured on.
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
        // M106 B4/B5: additive, and absent when there is nothing to say, so a
        // component with no portals and no broken sprites reports as before.
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
        // A probe fallback already runs the whole pass under vsync: nothing to
        // bail to in that case.
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
