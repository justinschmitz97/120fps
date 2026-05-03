import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import type { HarnessResult } from "./harness.js";
import type { PropCombination } from "./prop-gen-values.js";
import { extractProps } from "./prop-gen.js";
import { generateCombinations } from "./prop-gen-values.js";

const LAYOUT_TRANSITION_PROPS = new Set([
  "transform", "opacity", "height", "width",
  "max-height", "max-width", "all",
]);

export async function detectAnimations(page: Page): Promise<boolean> {
  return page.evaluate((layoutProps: string[]) => {
    const root = document.getElementById("root");
    if (!root) return false;

    const animations = document.getAnimations();
    if (animations.some((a) => {
      const target = (a as any).effect?.target;
      return target instanceof Element && root.contains(target);
    })) return true;

    const layoutSet = new Set(layoutProps);
    const elements = root.querySelectorAll("*");
    for (const el of elements) {
      const style = getComputedStyle(el);
      if (style.animationName !== "none") return true;

      const transitionProp = style.transitionProperty;
      if (transitionProp && transitionProp !== "none") {
        const props = transitionProp.split(",").map((p) => p.trim());
        const durs = style.transitionDuration.split(",").map((d) => d.trim());
        for (let i = 0; i < props.length; i++) {
          const dur = durs[i % durs.length];
          if (layoutSet.has(props[i]) && dur !== "0s") return true;
        }
      }
    }
    return false;
  }, [...LAYOUT_TRANSITION_PROPS]);
}

export async function tryCollectGarbage(cdp: CDPSession): Promise<void> {
  try {
    await cdp.send("HeapProfiler.collectGarbage" as any);
  } catch {
    // Best-effort: some Chromium builds don't expose HeapProfiler
  }
}

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
  heapDelta?: number;
  hasAnimation?: boolean;
  mountTraces?: TraceEvent[][];
}

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

    if (nestingStack.length === 0) {
      totalDuration += durMs;
    }

    nestingStack.push(eventEnd);

    if (event.name && SCRIPT_EVENT_NAMES.has(event.name)) {
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
  const traceComplete = new Promise<void>((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Tracing.tracingComplete timed out")),
      TRACE_TIMEOUT_MS,
    );
    cdp.once("Tracing.tracingComplete", () => {
      clearTimeout(timer);
      timer = undefined;
      resolve();
    });
  });

  // Prevent unhandled rejection if timeout fires before await
  traceComplete.catch(() => {});

  try {
    await cdp.send("Tracing.start", {
      categories: "devtools.timeline,v8.execute",
      options: "sampling-frequency=10000",
    } as any);

    await action();

    await cdp.send("Tracing.end");
    await traceComplete;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    cdp.off("Tracing.dataCollected", onData);
  }

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
): Promise<{ mountDur: number; unmountDur: number; domNodeCount: number; hasAnimation: boolean; mountEvents: TraceEvent[] }> {
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
      [safeProps, FUNCTION_MARKER] as [Record<string, unknown>, string],
    );
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
  });

  const domNodeCount = await page.evaluate(
    () => document.querySelectorAll("*").length,
  );

  const hasAnimation = await detectAnimations(page);

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
    hasAnimation,
    mountEvents,
  };
}

export interface RerenderResult {
  comboIndex: number;
  props: PropCombination;
  stable: TimingResult;
  change?: TimingResult;
  changeToProps?: PropCombination;
}

export interface MeasureRerenderOptions {
  samples?: number;
  cpuThrottle?: number;
  warmupRuns?: number;
  combos?: PropCombination[];
}

async function mountAndWait(page: Page, props: PropCombination): Promise<void> {
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
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

async function rerenderAndTrace(
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
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
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

    // Warmup
    if (warmupRuns > 0 && combos.length > 0) {
      await mountAndWait(page, combos[0]);
      for (let w = 0; w < warmupRuns; w++) {
        await rerenderAndTrace(page, cdp, combos[0]);
      }
    }

    const results: RerenderResult[] = [];

    for (let ci = 0; ci < combos.length; ci++) {
      const props = combos[ci];

      // Stable rerender: mount with props, then rerender with same props N times
      const stableSamples: number[] = [];
      for (let s = 0; s < sampleCount; s++) {
        await tryCollectGarbage(cdp);
        await mountAndWait(page, props);
        stableSamples.push(await rerenderAndTrace(page, cdp, props));
      }

      const result: RerenderResult = {
        comboIndex: ci,
        props,
        stable: buildTimingResult(stableSamples),
      };

      // Prop-change rerender: mount with current props, rerender with next combo's props
      // Skip when either combo is a scale combo — cross-scale rerenders are not meaningful
      if (combos.length > 1) {
        const nextProps = combos[(ci + 1) % combos.length];
        const isScale = "__120fps_scaleN" in props;
        const nextIsScale = "__120fps_scaleN" in nextProps;
        if (!isScale && !nextIsScale) {
          const changeSamples: number[] = [];
          for (let s = 0; s < sampleCount; s++) {
            await tryCollectGarbage(cdp);
            await mountAndWait(page, props);
            changeSamples.push(await rerenderAndTrace(page, cdp, nextProps));
          }
          result.change = buildTimingResult(changeSamples);
          result.changeToProps = nextProps;
        }
      }

      results.push(result);
    }

    return results;
  } finally {
    if (browser) await browser.close();
  }
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
      const mountTraces: TraceEvent[][] = [];
      let domNodeCount = 0;
      let hasAnimation = false;

      let heapBefore = 0;
      try {
        const pre = await cdp.send("Runtime.getHeapUsage" as any) as { usedSize: number };
        heapBefore = pre.usedSize;
      } catch { /* CDP method may not be available */ }

      for (let s = 0; s < sampleCount; s++) {
        await tryCollectGarbage(cdp);
        const run = await runMountUnmount(page, cdp, props);
        mountSamples.push(run.mountDur);
        unmountSamples.push(run.unmountDur);
        mountTraces.push(run.mountEvents);
        if (s === 0) {
          domNodeCount = run.domNodeCount;
          hasAnimation = run.hasAnimation;
        }
      }

      let heapDelta = 0;
      try {
        const post = await cdp.send("Runtime.getHeapUsage" as any) as { usedSize: number };
        heapDelta = post.usedSize - heapBefore;
      } catch { /* fall back to 0 */ }

      results.push({
        comboIndex: ci,
        props,
        mount: buildTimingResult(mountSamples),
        unmount: buildTimingResult(unmountSamples),
        domNodeCount,
        heapDelta,
        hasAnimation,
        mountTraces,
      });
    }

    return results;
  } finally {
    if (browser) await browser.close();
  }
}
