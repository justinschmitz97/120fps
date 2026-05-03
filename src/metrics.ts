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

export interface CostBucket {
  source: string;
  durationMs: number;
  percentage: number;
  category: "user" | "package" | "react" | "browser";
}

export interface CostAttribution {
  buckets: CostBucket[];
  unattributed: number;
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

const REACT_PACKAGES = new Set([
  "react",
  "react-dom",
  "react_jsx-runtime",
  "scheduler",
]);

function extractUrl(event: TraceEvent): string | undefined {
  const data = (event.args as any)?.data;
  if (!data) return undefined;
  if (typeof data.url === "string" && data.url) return data.url;
  if (typeof data.fileName === "string" && data.fileName) return data.fileName;
  if (typeof data.scriptName === "string" && data.scriptName) return data.scriptName;
  if (data.stackTrace?.callFrames?.[0]?.url) return data.stackTrace.callFrames[0].url;
  return undefined;
}

function resolveSource(rawUrl: string): { source: string; category: CostBucket["category"] } {
  if (
    rawUrl.startsWith("chrome-extension://") ||
    rawUrl.startsWith("native ") ||
    rawUrl.startsWith("v8/") ||
    !rawUrl.startsWith("http")
  ) {
    return { source: "browser", category: "browser" };
  }

  let cleaned: string;
  try {
    const url = new URL(rawUrl);
    cleaned = url.pathname;
  } catch {
    return { source: "browser", category: "browser" };
  }

  if (cleaned.startsWith("/@fs/")) {
    cleaned = cleaned.slice(4);
  }

  const nmIndex = cleaned.indexOf("node_modules/");
  if (nmIndex !== -1) {
    let pkgPath = cleaned.slice(nmIndex + "node_modules/".length);
    if (pkgPath.startsWith(".vite/deps/")) {
      pkgPath = pkgPath.slice(".vite/deps/".length);
    }
    pkgPath = pkgPath.replace(/\.js$/, "").replace(/\.mjs$/, "");
    let pkgName: string;
    if (pkgPath.startsWith("@")) {
      const parts = pkgPath.split("/");
      if (parts.length >= 2) {
        pkgName = `${parts[0]}/${parts[1]}`;
      } else {
        const underscoreIdx = pkgPath.indexOf("_");
        if (underscoreIdx > 0) {
          const scope = pkgPath.slice(0, underscoreIdx);
          const rest = pkgPath.slice(underscoreIdx + 1);
          const dashOrEnd = rest.indexOf("/");
          pkgName = `${scope}/${dashOrEnd >= 0 ? rest.slice(0, dashOrEnd) : rest}`;
        } else {
          pkgName = pkgPath;
        }
      }
    } else {
      const slashIdx = pkgPath.indexOf("/");
      pkgName = slashIdx >= 0 ? pkgPath.slice(0, slashIdx) : pkgPath;
    }

    if (REACT_PACKAGES.has(pkgName)) {
      return { source: "react", category: "react" };
    }
    return { source: pkgName, category: "package" };
  }

  const srcPath = cleaned.startsWith("/") ? cleaned.slice(1) : cleaned;
  return { source: srcPath, category: "user" };
}

export function attributeCost(events: TraceEvent[]): CostAttribution {
  const scriptEvents = events.filter(
    (e) => e.ph === "X" && typeof e.dur === "number" && e.ts !== undefined &&
      e.name !== undefined && SCRIPT_EVENTS.has(e.name),
  );

  if (scriptEvents.length === 0) {
    return { buckets: [], unattributed: 0 };
  }

  const sorted = [...scriptEvents].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

  interface NestingEntry { end: number; source: string; childDur: number }
  const stack: NestingEntry[] = [];
  const sourceDurations = new Map<string, { durationMs: number; category: CostBucket["category"] }>();

  function addDuration(source: string, category: CostBucket["category"], ms: number) {
    const existing = sourceDurations.get(source);
    if (existing) {
      existing.durationMs += ms;
    } else {
      sourceDurations.set(source, { durationMs: ms, category });
    }
  }

  for (const event of sorted) {
    const durMs = event.dur! / 1000;
    const eventStart = event.ts!;
    const eventEnd = eventStart + event.dur!;

    while (stack.length > 0 && stack[stack.length - 1].end <= eventStart) {
      stack.pop();
    }

    const url = extractUrl(event);
    const resolved = url ? resolveSource(url) : { source: "browser", category: "browser" as const };

    if (stack.length > 0) {
      stack[stack.length - 1].childDur += durMs;
    }

    stack.push({ end: eventEnd, source: resolved.source, childDur: 0 });
    addDuration(resolved.source, resolved.category, durMs);
  }

  // Second pass: subtract child durations from parents
  // We need to re-process to correctly handle nesting
  sourceDurations.clear();

  interface Entry { end: number; source: string; category: CostBucket["category"]; durMs: number }
  const entries: Entry[] = [];
  for (const event of sorted) {
    const durMs = event.dur! / 1000;
    const eventStart = event.ts!;
    const eventEnd = eventStart + event.dur!;
    const url = extractUrl(event);
    const resolved = url ? resolveSource(url) : { source: "browser", category: "browser" as const };
    entries.push({ end: eventEnd, source: resolved.source, category: resolved.category, durMs });
  }

  const nestStack: { end: number; idx: number }[] = [];
  const childDeductions = new Float64Array(entries.length);

  for (let i = 0; i < entries.length; i++) {
    const eventStart = sorted[i].ts!;
    while (nestStack.length > 0 && nestStack[nestStack.length - 1].end <= eventStart) {
      nestStack.pop();
    }

    if (nestStack.length > 0) {
      const parentIdx = nestStack[nestStack.length - 1].idx;
      childDeductions[parentIdx] += entries[i].durMs;
    }

    nestStack.push({ end: entries[i].end, idx: i });
  }

  for (let i = 0; i < entries.length; i++) {
    const net = entries[i].durMs - childDeductions[i];
    if (net > 0) {
      addDuration(entries[i].source, entries[i].category, net);
    }
  }

  let totalMs = 0;
  for (const v of sourceDurations.values()) {
    totalMs += v.durationMs;
  }

  const buckets: CostBucket[] = [];
  for (const [source, data] of sourceDurations) {
    buckets.push({
      source,
      durationMs: data.durationMs,
      percentage: totalMs > 0 ? (data.durationMs / totalMs) * 100 : 0,
      category: data.category,
    });
  }

  buckets.sort((a, b) => b.durationMs - a.durationMs);

  return { buckets, unattributed: 0 };
}

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
