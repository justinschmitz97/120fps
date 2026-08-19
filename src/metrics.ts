import type { CDPSession, Page } from "playwright";
import { collectTrace, countComponentNodes, type TraceEvent } from "./measure.js";

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
  growthClass: "constant" | "linear" | "quadratic" | "exponential" | "inconclusive";
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
  // M66: how many mount windows the buckets were folded from, and what they
  // summed to before the fold. Without them a reader cannot tell a per-mount
  // breakdown from a total across every measured mount.
  sampleCount: number;
  totalScriptingMs: number;
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

  // Last, not first: pnpm nests the real package under its own node_modules/
  // inside the store entry (node_modules/.pnpm/pkg@1.2.3/node_modules/pkg/…),
  // so the first occurrence lands inside ".pnpm" instead of the package.
  const nmIndex = cleaned.lastIndexOf("node_modules/");
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

type SourceDurations = Map<string, { durationMs: number; category: CostBucket["category"] }>;

// One trace window's script events, net of nesting: a child span's time is
// subtracted from its parent so React→Radix→motion never double-counts.
function accumulateWindow(events: TraceEvent[], into: SourceDurations): void {
  const scriptEvents = events.filter(
    (e) => e.ph === "X" && typeof e.dur === "number" && e.ts !== undefined &&
      e.name !== undefined && SCRIPT_EVENTS.has(e.name),
  );
  if (scriptEvents.length === 0) return;

  const sorted = [...scriptEvents].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

  interface Entry { end: number; source: string; category: CostBucket["category"]; durMs: number }
  const entries: Entry[] = sorted.map((event) => {
    const url = extractUrl(event);
    const resolved = url ? resolveSource(url) : { source: "browser", category: "browser" as const };
    return {
      end: event.ts! + event.dur!,
      source: resolved.source,
      category: resolved.category,
      durMs: event.dur! / 1000,
    };
  });

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
    if (net <= 0) continue;
    const existing = into.get(entries[i].source);
    if (existing) {
      existing.durationMs += net;
    } else {
      into.set(entries[i].source, { durationMs: net, category: entries[i].category });
    }
  }
}

// M66: a combo's mount is measured N times, so N windows arrive. Summing them
// produced a breakdown N× the Mount column it sits next to. Buckets are the mean
// scripting time inside one mount; `totalScriptingMs` and `sampleCount` keep the
// raw sum and the window count recoverable.
export function attributeCost(
  traces: TraceEvent[] | TraceEvent[][],
): CostAttribution {
  const windows: TraceEvent[][] = Array.isArray(traces[0])
    ? (traces as TraceEvent[][])
    : [traces as TraceEvent[]];
  const sampleCount = Math.max(1, windows.length);

  const sourceDurations: SourceDurations = new Map();
  for (const window of windows) {
    accumulateWindow(window, sourceDurations);
  }

  let totalScriptingMs = 0;
  for (const v of sourceDurations.values()) {
    totalScriptingMs += v.durationMs;
  }

  const buckets: CostBucket[] = [];
  for (const [source, data] of sourceDurations) {
    buckets.push({
      source,
      durationMs: data.durationMs / sampleCount,
      percentage: totalScriptingMs > 0 ? (data.durationMs / totalScriptingMs) * 100 : 0,
      category: data.category,
    });
  }

  buckets.sort((a, b) => b.durationMs - a.durationMs);

  return { buckets, unattributed: 0, sampleCount, totalScriptingMs };
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
      if (!isNested) {
        metrics.scriptDuration += durMs;
      }
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

// Goodness of an arbitrary model on the raw metric. Non-finite (an overflowing
// back-transform) means the model explains nothing, not that it wins.
function rawR2(
  points: { n: number; metric: number }[],
  predict: (n: number) => number,
): number {
  const mean = points.reduce((sum, p) => sum + p.metric, 0) / points.length;
  let ssTot = 0;
  let ssRes = 0;
  for (const p of points) {
    ssTot += (p.metric - mean) ** 2;
    ssRes += (p.metric - predict(p.n)) ** 2;
  }
  if (ssTot === 0) return 0;
  const r2 = 1 - ssRes / ssTot;
  return Number.isFinite(r2) ? r2 : 0;
}

// The share of the linear fit's leftover variance a candidate must still
// explain to be admitted. All three candidates are two-parameter fits, so an
// information criterion reduces to ranking by residual sum of squares: the
// rule that let noise flip an unchanged component between linear and
// quadratic. The margin has to be relative: on the default sweep a perfect
// quadratic only beats its own linear fit by 0.052 of R².
export const SUPERLINEAR_RESIDUAL_SHARE = 0.5;

// Cost that grew slower than its data over the measured sweep is not
// super-linear in that data, whatever curve happens to fit it.
export const SUPERLINEAR_MIN_EXPONENT = 1;

// The log-log slope between the sweep's endpoints: 1 means cost grew exactly as
// fast as n, 2 means it grew as n². Points that cannot be logged (n ≤ 0,
// metric ≤ 0, non-finite) carry no exponent and are dropped.
export function growthExponent(points: { n: number; metric: number }[]): number {
  const usable = points
    .filter((p) => p.n > 0 && p.metric > 0 && Number.isFinite(p.n) && Number.isFinite(p.metric))
    .sort((a, b) => a.n - b.n);
  if (usable.length < 2) return 0;
  const first = usable[0];
  const last = usable[usable.length - 1];
  if (last.n <= first.n) return 0;
  const exponent = Math.log(last.metric / first.metric) / Math.log(last.n / first.n);
  return Number.isFinite(exponent) ? exponent : 0;
}

// One predicate, so the growth column, the JSON and the hint can never disagree
// about what "superlinear" means.
export function isSuperlinearGrowth(curve: ScalingCurve | null | undefined): boolean {
  return curve?.growthClass === "quadratic" || curve?.growthClass === "exponential";
}

export function computeScalingCurve(
  points: { n: number; metric: number }[],
): ScalingCurve {
  if (points.length <= 1) {
    return { slope: 0, intercept: points[0]?.metric ?? 0, r2: 0, growthClass: "inconclusive" };
  }

  const linPoints = points.map((p) => ({ x: p.n, y: p.metric }));
  const linResult = linearRegression(linPoints);

  // Fewer than 3 distinct x values can't discriminate between growth models:
  // any candidate model fits an under-determined system with r2≈1.
  const distinctN = new Set(points.map((p) => p.n)).size;
  if (distinctN < 3) {
    return {
      slope: linResult.slope,
      intercept: linResult.intercept,
      r2: linResult.r2,
      growthClass: "inconclusive",
    };
  }

  // A non-positive slope means cost isn't growing with n: never classify as
  // linear/quadratic/exponential growth, even if a curved model fits well.
  if (linResult.slope <= 0) {
    return {
      slope: linResult.slope,
      intercept: linResult.intercept,
      r2: linResult.r2,
      growthClass: "constant",
    };
  }

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

  // The exponential candidate is fitted on log y but ranked against fits on
  // raw y, so its goodness is re-measured on raw y after back-transforming.
  // An r² across two response variables compares nothing.
  const allPositive = points.every((p) => p.metric > 0);
  const expFit = allPositive
    ? linearRegression(points.map((p) => ({ x: p.n, y: Math.log(p.metric) })))
    : undefined;
  const expR2 = expFit
    ? rawR2(points, (n) => Math.exp(expFit.intercept + expFit.slope * n))
    : 0;

  const linear: ScalingCurve = {
    slope: linResult.slope,
    intercept: linResult.intercept,
    r2: linResult.r2,
    growthClass: "linear",
  };

  // Magnitude gate: a superlinear label claims cost outran the data. Data that
  // grew 50x while cost grew 2.6x refutes the claim regardless of fit.
  if (growthExponent(points) < SUPERLINEAR_MIN_EXPONENT) return linear;

  // Fit gate: a nothing-left-to-explain linear fit admits no rival, and every
  // rival must still explain half of what linear leaves.
  const leftover = 1 - linResult.r2;
  if (leftover <= 1e-9) return linear;
  const admitted = [
    { r2: quadResult.r2, growthClass: "quadratic" as const },
    { r2: expR2, growthClass: "exponential" as const },
  ].filter((c) => 1 - c.r2 <= SUPERLINEAR_RESIDUAL_SHARE * leftover);
  if (admitted.length === 0) return linear;

  // M53's ranking, applied to the survivors: raw-y R² decides.
  admitted.sort((a, b) => b.r2 - a.r2);

  return { ...linear, growthClass: admitted[0].growthClass };
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

  const domNodeCount = await countComponentNodes(page);

  await page.evaluate(() => {
    const el = document.getElementById("__120fps_calibration");
    if (el) el.remove();
  });

  const metrics = parseMetrics(events);
  metrics.domNodeCount = domNodeCount;
  return metrics;
}

export interface DomScalePoint {
  n: number;
  domNodeCount?: number;
}

// A sweep that never changes the DOM did not exercise growth: either the
// component does not render its scaled prop, or the generated values do not
// satisfy it. Either way the growth class describes nothing.
export function isDomFlat(points: DomScalePoint[]): boolean {
  const counts = points
    .map((p) => p.domNodeCount)
    .filter((c): c is number => typeof c === "number");
  if (counts.length < 2) return false;
  return counts.every((c) => c === counts[0]);
}

export const SCALING_NO_EFFECT_WARNING = (propName: string): string =>
  `scaling prop "${propName}" did not change the DOM node count across scale points; ` +
  `the growth class describes nothing measured. Check that the component renders this prop.`;
