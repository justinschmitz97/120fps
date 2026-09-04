import type { CDPSession } from "playwright";
import type { PropCombination } from "../props/index.js";
import type { PageErrorDrain } from "./page-errors.js";
import type { MeasuredState } from "./dom.js";
import type { BrowserPool, MeasurementPacing } from "./pacing.js";

export interface TraceEvent {
  cat?: string;
  name?: string;
  dur?: number;
  ph?: string;
  ts?: number;
  args?: Record<string, unknown>;
}

interface ParsedDuration {
  scriptDuration: number;
  totalDuration: number;
}

const SCRIPT_EVENT_NAMES = new Set([
  "FunctionCall",
  "EvaluateScript",
  "v8.compile",
  "v8.run",
]);

// M106 B1 (calcom-F3): this bounds the FLUSH -- the window between
// `Tracing.end` and `Tracing.tracingComplete` -- and nothing else. It used to
// be armed before `Tracing.start`, so it covered the traced action too: an
// `open-close-10` stress pattern on a Radix portal spends 20 clicks at a 3 s
// `page.click` timeout each, and Radix `modal`'s `body { pointer-events: none }`
// made 19 of them time out. 57 s of interaction inside a 60 s window reported
// itself as a tracing stall, and the raw CDP error ended the run at exit 2. The
// action is bounded by its caller (the explore pass's remaining wall clock, the
// rAF fence elsewhere), which is where an action budget belongs.
export const TRACE_FLUSH_TIMEOUT_MS = 60_000;

export function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

// Type-7 quantile (the default of R and numpy), so the printed number
// reproduces in any standard tool. Below n≈20 it is dominated by the slowest
// sample and estimates no tail: see the glossary.
export function computeP95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const h = (sorted.length - 1) * 0.95;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

export function parseTraceDuration(events: TraceEvent[]): ParsedDuration {
  let scriptDuration = 0;
  let totalDuration = 0;

  const xEvents = events.filter(
    (e) => e.ph === "X" && typeof e.dur === "number" && e.ts !== undefined,
  );
  xEvents.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

  const nestingStack: number[] = [];

  for (const event of xEvents) {
    const durMs = event.dur! / 1000;
    const eventStart = event.ts!;
    const eventEnd = eventStart + event.dur!;

    while (
      nestingStack.length > 0 &&
      nestingStack[nestingStack.length - 1] <= eventStart
    ) {
      nestingStack.pop();
    }

    const isNested = nestingStack.length > 0;

    if (!isNested) {
      totalDuration += durMs;
    }

    nestingStack.push(eventEnd);

    if (!isNested && event.name && SCRIPT_EVENT_NAMES.has(event.name)) {
      scriptDuration += durMs;
    }
  }

  // Fallback: if no events had timestamps, use the old sum
  if (xEvents.length === 0 && events.some((e) => e.ph === "X" && typeof e.dur === "number")) {
    for (const event of events) {
      if (event.ph !== "X" || typeof event.dur !== "number") continue;
      const durMs = event.dur / 1000;
      totalDuration += durMs;
      if (event.name && SCRIPT_EVENT_NAMES.has(event.name)) {
        scriptDuration += durMs;
      }
    }
  }

  return { scriptDuration, totalDuration };
}

export async function collectTrace(
  cdp: CDPSession,
  action: () => Promise<void>,
): Promise<TraceEvent[]> {
  const chunks: TraceEvent[][] = [];

  const onData = (data: { value: TraceEvent[] }) => {
    chunks.push(data.value);
  };
  cdp.on("Tracing.dataCollected", onData);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let completed = false;
  // M106 B1: armed at `Tracing.end`, not here. Declared now because the
  // listener has to be attached before the action runs, or a fast flush would
  // resolve into nothing.
  let armFlushTimeout: () => void = () => {};
  // Review B-10: removed in the `finally` too. A trace that throws before the
  // flush never fires this listener, and consecutive failures accumulated them
  // on the same CDP session.
  let onComplete: (() => void) | undefined;
  const traceComplete = new Promise<void>((resolve, reject) => {
    armFlushTimeout = () => {
      if (completed || timer !== undefined) return;
      timer = setTimeout(
        () => reject(new Error("Tracing.tracingComplete timed out")),
        TRACE_FLUSH_TIMEOUT_MS,
      );
    };
    onComplete = () => {
      completed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      resolve();
    };
    cdp.once("Tracing.tracingComplete", onComplete);
  });

  // Prevent unhandled rejection if timeout fires before await
  traceComplete.catch(() => {});

  let failed = false;
  try {
    await cdp.send("Tracing.start", {
      categories: "devtools.timeline,v8.execute",
      options: "sampling-frequency=10000",
    } as any);

    try {
      await action();
    } finally {
      // The flush window opens here: `Tracing.end` and everything after it.
      armFlushTimeout();
      await cdp.send("Tracing.end");
    }
    await traceComplete;
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    cdp.off("Tracing.dataCollected", onData);
    if (onComplete) cdp.off("Tracing.tracingComplete", onComplete);
    // A trace that never completed leaves the session started, and the next
    // Tracing.start then fails with "already been started": turning one lost
    // sample into a dead run. Recovery is best-effort and never masks the
    // original error.
    if (failed) {
      try {
        await cdp.send("Tracing.end");
      } catch {
        // Already stopped, or the session is gone with the page.
      }
    }
  }

  return chunks.flat();
}

export interface MeasureOptions {
  samples?: number;
  cpuThrottle?: number;
  combos?: PropCombination[];
  warmupRuns?: number;
  // M37: reuse pooled browsers (fresh context per session) instead of
  // launching per pass.
  pool?: BrowserPool;
  // Called once per consumed context retry, so a survived reload still reaches
  // the report instead of vanishing into a slightly slower run.
  onWarning?: (warning: string) => void;
}

export interface TimingResult {
  samples: number[];
  median: number;
  p95: number;
}

export interface MountResult {
  comboIndex: number;
  props: PropCombination;
  mount: TimingResult;
  unmount: TimingResult;
  domNodeCount: number;
  heapDelta?: number;
  hasAnimation?: boolean;
  // M40: what scene these numbers describe.
  measuredState?: MeasuredState;
  mountTraces?: TraceEvent[][];
  // M35: which frame pacing produced this combo's numbers.
  pacing?: MeasurementPacing;
  // M59: everything the page threw or logged as an error while this combo was
  // measured. Absent when the page stayed quiet.
  pageErrors?: PageErrorDrain;
  // M106 B4 (dub-F6): how much of `domNodeCount` was rendered outside `#root`.
  // Absent when the component rendered no portal content, so a report that
  // never had portals is byte-identical.
  orphanNodes?: number;
  // M106 B5 (calcom-F5): `<use href="#id">` references whose id no element in
  // the document defines. Absent when every sprite reference resolved.
  unresolvedSpriteRefs?: string[];
}

export function buildTimingResult(samples: number[]): TimingResult {
  return {
    samples,
    median: computeMedian(samples),
    p95: computeP95(samples),
  };
}

// M99 (I4): errors raised while this combo's props were rerendered into
// `combos[toComboIndex]`'s props. Neither combo rendered those props on its
// own, so the errors belong to the transition between the two.
export interface TransitionPageErrors {
  toComboIndex: number;
  errors: PageErrorDrain;
}

// M99 (I4): the prop-change rerender for one combo. `run` receives a callback
// that closes the combo's OWN error window again, for the mounts of its own
// props that the rerender loop performs.
export interface TransitionWindow {
  toComboIndex: number;
  run: (claimOwnWindow: () => void) => Promise<void>;
}

export interface RerenderResult {
  comboIndex: number;
  props: PropCombination;
  stable: TimingResult;
  change?: TimingResult;
  changeToProps?: PropCombination;
  // M35: which frame pacing produced this combo's numbers.
  pacing?: MeasurementPacing;
  // M59: page errors raised while this combo's rerenders were measured.
  pageErrors?: PageErrorDrain;
  // M99 (I4): errors raised by the prop-change rerender only.
  transitionPageErrors?: TransitionPageErrors;
}

// M99 (I4): the combo that follows `ci`, wrapping at the end of the list, so
// the last row reports its transition to combo 0 rather than to a row that
// does not exist.
export function nextComboIndex(comboIndex: number, comboCount: number): number {
  return comboCount > 0 ? (comboIndex + 1) % comboCount : 0;
}

export interface MeasureRerenderOptions {
  samples?: number;
  cpuThrottle?: number;
  warmupRuns?: number;
  combos?: PropCombination[];
  // M35: combo indices already known to animate (from the mount pass); they
  // are measured under vsync pacing from the start.
  animatedComboIndices?: number[];
  // M37: reuse pooled browsers (fresh context per session).
  pool?: BrowserPool;
  onWarning?: (warning: string) => void;
}
