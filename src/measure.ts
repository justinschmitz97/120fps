import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import type { HarnessResult } from "./harness.js";
import type { PropCombination } from "./prop-gen-values.js";
import { extractProps } from "./prop-gen.js";
import { generateCombinations } from "./prop-gen-values.js";

export interface MeasureOptions {
  samples?: number;
  cpuThrottle?: number;
  combos?: PropCombination[];
  warmupRuns?: number;
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
}

interface TraceEvent {
  cat?: string;
  name?: string;
  dur?: number;
  ph?: string;
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

const TRACE_TIMEOUT_MS = 30_000;

export function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function computeP95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export function parseTraceDuration(events: TraceEvent[]): ParsedDuration {
  let scriptDuration = 0;
  let totalDuration = 0;

  for (const event of events) {
    if (event.ph !== "X" || typeof event.dur !== "number") continue;
    const durMs = event.dur / 1000;
    totalDuration += durMs;
    if (event.name && SCRIPT_EVENT_NAMES.has(event.name)) {
      scriptDuration += durMs;
    }
  }

  return { scriptDuration, totalDuration };
}

async function collectTrace(
  cdp: CDPSession,
  action: () => Promise<void>,
): Promise<TraceEvent[]> {
  const chunks: TraceEvent[][] = [];

  const onData = (data: { value: TraceEvent[] }) => {
    chunks.push(data.value);
  };
  cdp.on("Tracing.dataCollected", onData);

  const traceComplete = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Tracing.tracingComplete timed out")),
      TRACE_TIMEOUT_MS,
    );
    cdp.once("Tracing.tracingComplete", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  await cdp.send("Tracing.start", {
    categories: "devtools.timeline,v8.execute",
    options: "sampling-frequency=10000",
  } as any);

  await action();

  await cdp.send("Tracing.end");
  await traceComplete;

  cdp.off("Tracing.dataCollected", onData);

  return chunks.flat();
}

const FUNCTION_MARKER = "__120fps_fn__";

function serializeProps(props: PropCombination): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "function") {
      result[key] = FUNCTION_MARKER;
    } else {
      result[key] = value;
    }
  }
  return result;
}

function buildTimingResult(samples: number[]): TimingResult {
  return {
    samples,
    median: computeMedian(samples),
    p95: computeP95(samples),
  };
}

async function runMountUnmount(
  page: Page,
  cdp: CDPSession,
  props: PropCombination,
): Promise<{ mountDur: number; unmountDur: number; domNodeCount: number }> {
  await page.evaluate(() => (window as any).__120fps.unmount());

  const safeProps = serializeProps(props);
  const mountEvents = await collectTrace(cdp, async () => {
    await page.evaluate(
      ([p, marker]: [any, string]) => {
        for (const k of Object.keys(p)) {
          if (p[k] === marker) p[k] = () => {};
        }
        (window as any).__120fps.mount(p);
      },
      [safeProps, FUNCTION_MARKER] as const,
    );
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
  });

  const domNodeCount = await page.evaluate(
    () => document.querySelectorAll("*").length,
  );

  const mountParsed = parseTraceDuration(mountEvents);

  const unmountEvents = await collectTrace(cdp, async () => {
    await page.evaluate(() => (window as any).__120fps.unmount());
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
  });

  const unmountParsed = parseTraceDuration(unmountEvents);

  return {
    mountDur: mountParsed.totalDuration,
    unmountDur: unmountParsed.totalDuration,
    domNodeCount,
  };
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

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);

    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });

    await page.goto(harness.url);
    await page.waitForFunction(
      () => typeof (window as any).__120fps === "object",
      { timeout: 10000 },
    );

    // Warmup: JIT + module cache stabilization (results discarded)
    if (warmupRuns > 0 && combos.length > 0) {
      for (let w = 0; w < warmupRuns; w++) {
        await runMountUnmount(page, cdp, combos[0]);
      }
    }

    const results: MountResult[] = [];

    for (let ci = 0; ci < combos.length; ci++) {
      const props = combos[ci];
      const mountSamples: number[] = [];
      const unmountSamples: number[] = [];
      let domNodeCount = 0;

      for (let s = 0; s < sampleCount; s++) {
        const run = await runMountUnmount(page, cdp, props);
        mountSamples.push(run.mountDur);
        unmountSamples.push(run.unmountDur);
        if (s === 0) domNodeCount = run.domNodeCount;
      }

      results.push({
        comboIndex: ci,
        props,
        mount: buildTimingResult(mountSamples),
        unmount: buildTimingResult(unmountSamples),
        domNodeCount,
      });
    }

    return results;
  } finally {
    if (browser) await browser.close();
  }
}
