import type { CDPSession, Page } from "playwright";
import { collectTrace, type TraceEvent } from "./measure.js";

export interface LongTask {
  startTime: number;
  duration: number;
}

export interface FrameTiming {
  timestamp: number;
  duration: number;
}

export interface CdpMetrics {
  paintCount: number;
  paintDuration: number;
  layoutCount: number;
  layoutDuration: number;
  styleRecalcCount: number;
  styleRecalcDuration: number;
  scriptDuration: number;
  totalDuration: number;
  longTasks: LongTask[];
  frames: FrameTiming[];
  jankFrameCount: number;
  droppedFrameCount: number;
  layoutShiftScore: number;
  domNodeCount: number;
  heapDelta: number;
}

export interface ScalingCurve {
  slope: number;
  intercept: number;
  r2: number;
  growthClass: "constant" | "linear" | "quadratic" | "exponential";
}

export interface ParseMetricsOptions {
  filterToMarks?: boolean;
}

const SCRIPT_EVENTS = new Set([
  "FunctionCall",
  "EvaluateScript",
  "v8.compile",
  "v8.run",
]);

const STYLE_RECALC_EVENTS = new Set(["UpdateLayoutTree", "RecalcStyles"]);

const JANK_THRESHOLD_MS = 16.67;
const LONG_TASK_THRESHOLD_MS = 50;

function findMarkWindow(
  events: TraceEvent[],
): { start: number; end: number } | null {
  let start: number | null = null;
  let end: number | null = null;
  for (const e of events) {
    if (
      e.name === "__120fps_start" &&
      (e as any).cat === "blink.user_timing"
    ) {
      start = e.ts!;
    }
    if (
      e.name === "__120fps_end" &&
      (e as any).cat === "blink.user_timing"
    ) {
      end = e.ts!;
    }
  }
  if (start !== null && end !== null) return { start, end };
  return null;
}

export function parseMetrics(
  events: TraceEvent[],
  options: ParseMetricsOptions = {},
): CdpMetrics {
  let filtered = events;
  if (options.filterToMarks) {
    const window = findMarkWindow(events);
    if (window) {
      filtered = events.filter((e) => {
        if (e.ts === undefined) return false;
        return e.ts >= window.start && e.ts <= window.end;
      });
    }
  }

  const metrics: CdpMetrics = {
    paintCount: 0,
    paintDuration: 0,
    layoutCount: 0,
    layoutDuration: 0,
    styleRecalcCount: 0,
    styleRecalcDuration: 0,
    scriptDuration: 0,
    totalDuration: 0,
    longTasks: [],
    frames: [],
    jankFrameCount: 0,
    droppedFrameCount: 0,
    layoutShiftScore: 0,
    domNodeCount: 0,
    heapDelta: 0,
  };

  // Sort by timestamp for nesting detection
  const sorted = [...filtered].filter(
    (e) => e.ts !== undefined,
  );
  sorted.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

  // Stack for nesting: each entry is the end timestamp (µs) of an enclosing event
  const nestingStack: number[] = [];

  for (const event of sorted) {
    // LayoutShift events (instant, not X-phase)
    if (event.name === "LayoutShift") {
      const args = (event as any).args;
      if (args?.data) {
        const score =
          args.data.score ?? args.data.cumulative_score ?? 0;
        metrics.layoutShiftScore += score;
      }
      continue;
    }

    if (event.ph !== "X" || typeof event.dur !== "number") continue;

    const durMs = event.dur / 1000;
    const eventStart = event.ts ?? 0;
    const eventEnd = eventStart + event.dur;

    // Pop expired nesting parents
    while (
      nestingStack.length > 0 &&
      nestingStack[nestingStack.length - 1] <= eventStart
    ) {
      nestingStack.pop();
    }

    const isNested = nestingStack.length > 0;

    if (!isNested) {
      metrics.totalDuration += durMs;
    }

    nestingStack.push(eventEnd);

    if (event.name === "Paint") {
      metrics.paintCount++;
      metrics.paintDuration += durMs;
    } else if (event.name === "Layout") {
      metrics.layoutCount++;
      metrics.layoutDuration += durMs;
    } else if (event.name && STYLE_RECALC_EVENTS.has(event.name)) {
      metrics.styleRecalcCount++;
      metrics.styleRecalcDuration += durMs;
    }

    if (event.name && SCRIPT_EVENTS.has(event.name)) {
      metrics.scriptDuration += durMs;
      if (durMs > LONG_TASK_THRESHOLD_MS) {
        metrics.longTasks.push({
          startTime: eventStart / 1000,
          duration: durMs,
        });
      }
    }

    if (event.name === "BeginFrame" || event.name === "DrawFrame") {
      const frame: FrameTiming = {
        timestamp: eventStart / 1000,
        duration: durMs,
      };
      metrics.frames.push(frame);
      if (durMs > JANK_THRESHOLD_MS) {
        metrics.jankFrameCount++;
        metrics.droppedFrameCount += Math.floor(durMs / JANK_THRESHOLD_MS) - 1;
      }
    }
  }

  return metrics;
}

const INPUT_EVENT_TYPES = new Set([
  "click",
  "mousedown",
  "mouseup",
  "keydown",
  "keyup",
  "keypress",
  "pointerdown",
  "pointerup",
  "touchstart",
  "touchend",
]);

export function computeINP(traces: TraceEvent[][]): number {
  let maxINP = 0;

  for (const events of traces) {
    const sorted = [...events]
      .filter((e) => e.ts !== undefined)
      .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

    let lastInputTs: number | null = null;

    for (const event of sorted) {
      if (
        event.name === "EventDispatch" &&
        (event as any).args?.data?.type &&
        INPUT_EVENT_TYPES.has((event as any).args.data.type)
      ) {
        lastInputTs = event.ts ?? 0;
      }

      if (event.name === "Paint" && lastInputTs !== null) {
        const gapMs = ((event.ts ?? 0) - lastInputTs) / 1000;
        if (gapMs > maxINP) maxINP = gapMs;
        lastInputTs = null;
      }
    }
  }

  return maxINP;
}

export function linearRegression(
  points: { x: number; y: number }[],
): { slope: number; intercept: number; r2: number } {
  if (points.length <= 1) return { slope: 0, intercept: 0, r2: 0 };

  const n = points.length;
  let sumX = 0,
    sumY = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let ssXY = 0,
    ssXX = 0,
    ssTot = 0;
  for (const p of points) {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    ssXY += dx * dy;
    ssXX += dx * dx;
    ssTot += dy * dy;
  }

  if (ssXX === 0 || ssTot === 0) return { slope: 0, intercept: meanY, r2: 0 };

  const slope = ssXY / ssXX;
  const intercept = meanY - slope * meanX;

  let ssRes = 0;
  for (const p of points) {
    const predicted = slope * p.x + intercept;
    ssRes += (p.y - predicted) ** 2;
  }
  const r2 = 1 - ssRes / ssTot;

  return { slope, intercept, r2 };
}

export function computeScalingCurve(
  points: { n: number; metric: number }[],
): ScalingCurve {
  if (points.length <= 1) {
    return { slope: 0, intercept: points[0]?.metric ?? 0, r2: 0, growthClass: "constant" };
  }

  const linPoints = points.map((p) => ({ x: p.n, y: p.metric }));
  const linResult = linearRegression(linPoints);

  if (linResult.r2 < 0.5) {
    return {
      slope: linResult.slope,
      intercept: linResult.intercept,
      r2: linResult.r2,
      growthClass: "constant",
    };
  }

  const quadPoints = points.map((p) => ({ x: p.n ** 2, y: p.metric }));
  const quadResult = linearRegression(quadPoints);

  const allPositive = points.every((p) => p.metric > 0);
  const expResult = allPositive
    ? linearRegression(points.map((p) => ({ x: p.n, y: Math.log(p.metric) })))
    : { slope: 0, intercept: 0, r2: 0 };

  const candidates: { r2: number; growthClass: ScalingCurve["growthClass"] }[] = [
    { r2: linResult.r2, growthClass: "linear" },
    { r2: quadResult.r2, growthClass: "quadratic" },
    { r2: expResult.r2, growthClass: "exponential" },
  ];

  candidates.sort((a, b) => b.r2 - a.r2);

  return {
    slope: linResult.slope,
    intercept: linResult.intercept,
    r2: linResult.r2,
    growthClass: candidates[0].growthClass,
  };
}

export async function createCalibrationTrace(
  page: Page,
  cdp: CDPSession,
): Promise<CdpMetrics> {
  const events = await collectTrace(cdp, async () => {
    await page.evaluate(() => {
      const container = document.createElement("div");
      container.id = "__120fps_calibration";
      for (let i = 0; i < 1000; i++) {
        const span = document.createElement("span");
        span.style.display = "block";
        span.style.width = `${(i % 100)}px`;
        span.textContent = `item-${i}`;
        container.appendChild(span);
      }
      document.body.appendChild(container);
      container.offsetHeight; // force layout
    });
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
  });

  const domNodeCount = await page.evaluate(
    () => document.querySelectorAll("*").length,
  );

  await page.evaluate(() => {
    const el = document.getElementById("__120fps_calibration");
    if (el) el.remove();
  });

  const metrics = parseMetrics(events);
  metrics.domNodeCount = domNodeCount;
  return metrics;
}
