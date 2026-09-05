import type { CDPSession } from "playwright";
import type { PropCombination } from "../props/index.js";
import type { PageErrorDrain } from "./page-errors.js";
import type { MeasuredState } from "./dom.js";
import type { BrowserPool, MeasurementPacing } from "./pacing.js";
import { computeMedian, computeP95 } from "../shared/index.js";

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

// Bounds the flush only: covering the traced action too would make a slow action read as a stall.
export const TRACE_FLUSH_TIMEOUT_MS = 60_000;

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

  // Without timestamps nesting is undetectable, so this sum can double-count nested events.
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
  // Declared here because the listener must attach before the action; armed at `Tracing.end`.
  let armFlushTimeout: () => void = () => {};
  // Removed in the `finally` too: a throw before the flush would pile listeners on the session.
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
    // A started session makes the next `Tracing.start` fail with "already been started".
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
  // Reuse pooled browsers (fresh context per session) instead of launching per pass.
  pool?: BrowserPool;
  // Called once per consumed context retry, so a survived reload still reaches the report.
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
  // What scene these numbers describe.
  measuredState?: MeasuredState;
  mountTraces?: TraceEvent[][];
  // Which frame pacing produced this combo's numbers.
  pacing?: MeasurementPacing;
  // What the page threw or logged while this combo was measured; absent when it stayed quiet.
  pageErrors?: PageErrorDrain;
  // How much of `domNodeCount` rendered outside `#root`; absent keeps a portal-free report stable.
  orphanNodes?: number;
  // `<use href="#id">` references no element defines; absent when every sprite ref resolved.
  unresolvedSpriteRefs?: string[];
}

export function buildTimingResult(samples: number[]): TimingResult {
  return {
    samples,
    median: computeMedian(samples),
    p95: computeP95(samples),
  };
}

// Errors belong to the transition: neither combo rendered those props on its own.
export interface TransitionPageErrors {
  toComboIndex: number;
  errors: PageErrorDrain;
}

// `run`'s callback reclaims this combo's own error window for the mounts the loop performs.
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
  // Which frame pacing produced this combo's numbers.
  pacing?: MeasurementPacing;
  // Page errors raised while this combo's rerenders were measured.
  pageErrors?: PageErrorDrain;
  // Errors raised by the prop-change rerender only.
  transitionPageErrors?: TransitionPageErrors;
}

// Wraps at the end of the list, so the last row reports its transition to combo 0.
export function nextComboIndex(comboIndex: number, comboCount: number): number {
  return comboCount > 0 ? (comboIndex + 1) % comboCount : 0;
}

export interface MeasureRerenderOptions {
  samples?: number;
  cpuThrottle?: number;
  warmupRuns?: number;
  combos?: PropCombination[];
  // Combo indices the mount pass saw animate; measured under vsync pacing from the start.
  animatedComboIndices?: number[];
  // Reuse pooled browsers (fresh context per session).
  pool?: BrowserPool;
  onWarning?: (warning: string) => void;
}
