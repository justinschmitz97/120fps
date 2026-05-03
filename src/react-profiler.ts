import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import type { HarnessResult } from "./harness.js";
import type { PropCombination } from "./prop-gen-values.js";
import { collectTrace, parseTraceDuration, tryCollectGarbage, computeMedian } from "./measure.js";

export interface FiberInfo {
  name: string;
  renderCount: number;
  actualDurationMs: number;
  selfDurationMs: number;
  descendantCount: number;
}

export interface ProfilerSnapshot {
  fibers: Map<string, FiberInfo>;
  commitCount: number;
}

export interface ProfilerDiff {
  rerenderFibers: Array<{ name: string; renderCountDelta: number }>;
}

export interface CallbackIdentityDelta {
  propName: string;
  deltaMs: number;
}

export interface RenderAttribution {
  component: string;
  renderCount: number;
  totalDurationMs: number;
  selfDurationMs: number;
}

export interface ReactOptimizations {
  memoBailout: boolean;
  memoBailoutComponents?: string[];
  contextFanOut: boolean;
  contextFanOutComponents?: string[];
  callbackIdentityDeltas?: CallbackIdentityDelta[];
  portalOrphans?: number;
  renderAttribution?: RenderAttribution[];
}

export function detectFramework(entryContent: string): "react" | "vanilla" {
  if (/react-dom/.test(entryContent)) return "react";
  return "vanilla";
}

export function diffSnapshots(
  a: ProfilerSnapshot,
  b: ProfilerSnapshot,
): ProfilerDiff {
  const rerenderFibers: ProfilerDiff["rerenderFibers"] = [];
  for (const [id, fiberB] of b.fibers) {
    const fiberA = a.fibers.get(id);
    if (!fiberA) continue;
    const delta = fiberB.renderCount - fiberA.renderCount;
    if (delta > 0) {
      rerenderFibers.push({ name: fiberB.name, renderCountDelta: delta });
    }
  }
  rerenderFibers.sort((a, b) => b.renderCountDelta - a.renderCountDelta);
  return { rerenderFibers };
}

export function detectMemoBailouts(diff: ProfilerDiff): string[] {
  return diff.rerenderFibers
    .filter((f) => f.name !== "Root" && f.name !== "AppRoot")
    .map((f) => f.name);
}

export function detectContextFanOut(diff: ProfilerDiff): string[] {
  return diff.rerenderFibers
    .filter((f) => f.name !== "__120fpsContextProbe" && f.name !== "Root" && f.name !== "AppRoot")
    .map((f) => f.name);
}

export function computeRenderAttribution(
  snapshot: ProfilerSnapshot,
  top = 5,
): RenderAttribution[] {
  const fibers = [...snapshot.fibers.values()];
  fibers.sort((a, b) => b.selfDurationMs - a.selfDurationMs);
  return fibers.slice(0, top).map((f) => ({
    component: f.name,
    renderCount: f.renderCount,
    totalDurationMs: f.actualDurationMs,
    selfDurationMs: f.selfDurationMs,
  }));
}

export function computePortalOrphans(preCount: number, postCount: number): number {
  return Math.max(0, postCount - preCount);
}

export function hasReactWarning(opts: ReactOptimizations): boolean {
  if (opts.memoBailout) return true;
  if (opts.contextFanOut) return true;
  if (opts.portalOrphans && opts.portalOrphans > 0) return true;
  if (opts.callbackIdentityDeltas) {
    for (const d of opts.callbackIdentityDeltas) {
      if (d.deltaMs > 2) return true;
    }
  }
  return false;
}

// ====================================================================
// Profiler hook injection script
// ====================================================================

export const PROFILER_HOOK_SCRIPT = `
(function() {
  var fibers = {};
  var commitCount = 0;

  function walkFiber(fiber, depth) {
    if (!fiber) return;
    var name = fiber.type
      ? (fiber.type.displayName || fiber.type.name || "Anonymous")
      : (fiber.tag === 3 ? "Root" : "Unknown");
    var id = (fiber._debugID || fiber.index || 0) + "_" + name + "_" + depth;

    var descendants = 0;
    var child = fiber.child;
    while (child) {
      descendants++;
      child = child.sibling;
    }

    if (!fibers[id]) {
      fibers[id] = { name: name, renderCount: 0, actualDurationMs: 0, selfDurationMs: 0, descendantCount: descendants };
    }
    fibers[id].renderCount++;
    if (typeof fiber.actualDuration === "number") {
      fibers[id].actualDurationMs += fiber.actualDuration;
    }
    if (typeof fiber.selfBaseDuration === "number") {
      fibers[id].selfDurationMs += fiber.selfBaseDuration;
    }
    fibers[id].descendantCount = descendants;

    if (fiber.child) walkFiber(fiber.child, depth + 1);
    if (fiber.sibling) walkFiber(fiber.sibling, depth);
  }

  window.__120fps_profiler = {
    fibers: fibers,
    commitCount: 0,
    reset: function() {
      fibers = {};
      window.__120fps_profiler.fibers = fibers;
      window.__120fps_profiler.commitCount = 0;
      commitCount = 0;
    }
  };

  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject: function(renderer) {
      var id = window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.size + 1;
      window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.set(id, renderer);
      return id;
    },
    onCommitFiberRoot: function(rendererID, root) {
      commitCount++;
      window.__120fps_profiler.commitCount = commitCount;
      if (root && root.current) {
        walkFiber(root.current, 0);
      }
    },
    onCommitFiberUnmount: function() {},
    onScheduleFiberRoot: function() {},
    onPostCommitFiberRoot: function() {}
  };
})();
`;

export async function injectProfilerHook(cdp: CDPSession): Promise<void> {
  await cdp.send("Page.addScriptToEvaluateOnNewDocument" as any, {
    source: PROFILER_HOOK_SCRIPT,
  });
}

export async function collectProfilerData(page: Page): Promise<ProfilerSnapshot> {
  const raw = await page.evaluate(() => {
    const p = (window as any).__120fps_profiler;
    if (!p) return { fibers: {}, commitCount: 0 };
    const result: Record<string, any> = {};
    for (const [id, info] of Object.entries(p.fibers)) {
      result[id] = info;
    }
    return { fibers: result, commitCount: p.commitCount };
  });

  const fibers = new Map<string, FiberInfo>();
  for (const [id, info] of Object.entries(raw.fibers)) {
    const f = info as any;
    fibers.set(id, {
      name: f.name ?? "Unknown",
      renderCount: f.renderCount ?? 0,
      actualDurationMs: f.actualDurationMs ?? 0,
      selfDurationMs: f.selfDurationMs ?? 0,
      descendantCount: f.descendantCount ?? 0,
    });
  }

  return { fibers, commitCount: raw.commitCount };
}

export async function resetProfilerData(page: Page): Promise<void> {
  await page.evaluate(() => {
    const p = (window as any).__120fps_profiler;
    if (p && typeof p.reset === "function") p.reset();
  });
}

export async function countBodyOrphans(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.getElementById("root");
    let count = 0;
    for (const child of document.body.children) {
      if (child === root) continue;
      const tag = child.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "LINK" || tag === "NOSCRIPT") continue;
      if ((child as HTMLElement).dataset && "viteDev" in (child as any).dataset) continue;
      if (child.id && child.id.startsWith("vite-")) continue;
      count++;
    }
    return count;
  });
}

// ====================================================================
// Probe entry generation for context fan-out + callback identity
// ====================================================================

export interface ProbeEntryOptions {
  componentRelative: string;
  componentName: string;
  isDefaultExport: boolean;
}

export function generateProbeEntry(opts: ProbeEntryOptions): string {
  const importLine = opts.isDefaultExport
    ? `import ${opts.componentName} from "/${opts.componentRelative}";`
    : `import { ${opts.componentName} as Component } from "/${opts.componentRelative}";`;

  const componentRef = opts.isDefaultExport ? opts.componentName : "Component";

  return `
import { createElement, createContext, useState, useCallback, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
${importLine}

const __120fpsContext = createContext(0);

function __120fpsContextProbe({ children }: { children: ReactNode }) {
  const [value, setValue] = useState(0);
  (window as any).__120fps_forceContext = () => setValue((v: number) => v + 1);
  return createElement(__120fpsContext.Provider, { value }, children);
}

const container = document.getElementById("root")!;
let root = createRoot(container);
let mounted = false;
const stableCallbackCache = new Map<string, Function>();

(window as any).__120fps = {
  mount(props: any = {}) {
    if (mounted) {
      root.unmount();
      root = createRoot(container);
    }
    root.render(
      createElement(__120fpsContextProbe, null,
        createElement(${componentRef}, props)
      )
    );
    mounted = true;
  },
  unmount() {
    if (mounted) {
      root.unmount();
      root = createRoot(container);
      mounted = false;
    }
  },
  rerender(props: any = {}) {
    root.render(
      createElement(__120fpsContextProbe, null,
        createElement(${componentRef}, props)
      )
    );
  },
  forceContextUpdate() {
    (window as any).__120fps_forceContext?.();
  },
  rerenderWithStableCallbacks(props: any, fnPropNames: string[]) {
    const stableProps = { ...props };
    for (const name of fnPropNames) {
      if (!stableCallbackCache.has(name)) {
        stableCallbackCache.set(name, () => {});
      }
      stableProps[name] = stableCallbackCache.get(name);
    }
    this.rerender(stableProps);
  },
  rerenderWithFreshCallbacks(props: any, fnPropNames: string[]) {
    const freshProps = { ...props };
    for (const name of fnPropNames) {
      freshProps[name] = () => {};
    }
    this.rerender(freshProps);
  },
  getContainer() {
    return container;
  },
};

`;
}

export function generateProbeHtml(): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>120fps probe</title></head>
<body><div id="root"></div><script type="module" src="./probe-entry.tsx"></script></body>
</html>`;
}

// ====================================================================
// React analysis orchestrator
// ====================================================================

export interface ReactAnalysisOptions {
  combos: PropCombination[];
  samples?: number;
  cpuThrottle?: number;
  warmupRuns?: number;
  fnPropNames?: string[];
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

async function mountAndWaitProbe(page: Page, props: PropCombination): Promise<void> {
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

async function rerenderProbe(page: Page, props: PropCombination): Promise<void> {
  const safeProps = serializeProps(props);
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
}

export async function runReactAnalysis(
  harness: HarnessResult,
  options: ReactAnalysisOptions,
): Promise<Map<number, ReactOptimizations>> {
  const { combos, samples = 3, cpuThrottle = 4, warmupRuns = 1, fnPropNames = [] } = options;

  const probeEntryContent = fs.readFileSync(
    path.join(harness.harnessDir, "entry.tsx"),
    "utf-8",
  );

  const componentRelativeMatch = probeEntryContent.match(/from\s+"\/([^"]+)"/);
  const componentRelative = componentRelativeMatch?.[1] ?? "";

  const componentImportLine = probeEntryContent
    .split("\n")
    .find((line) => line.includes(`"/${componentRelative}"`));
  const nameMatch = componentImportLine?.match(/import\s+(\w+)|import\s+\{\s*(\w+)/);
  const componentName = nameMatch?.[1] ?? nameMatch?.[2] ?? "Component";
  const isDefaultExport = !!nameMatch?.[1];

  const probeEntry = generateProbeEntry({
    componentRelative,
    componentName,
    isDefaultExport,
  });

  const probeHtml = generateProbeHtml();

  fs.writeFileSync(path.join(harness.harnessDir, "probe-entry.tsx"), probeEntry);
  fs.writeFileSync(path.join(harness.harnessDir, "probe.html"), probeHtml);

  const harnessUrl = harness.url;
  const probeUrl = harnessUrl.replace(/\/$/, "/probe.html");

  const results = new Map<number, ReactOptimizations>();
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);

    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });
    await injectProfilerHook(cdp);

    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") pageErrors.push(msg.text());
    });

    await page.goto(probeUrl, { timeout: 15000 });
    try {
      await page.waitForFunction(
        () => typeof (window as any).__120fps === "object",
        { timeout: 15000 },
      );
    } catch (waitErr: any) {
      const errDetail = pageErrors.length > 0
        ? `Browser errors: ${pageErrors.join("; ")}`
        : "No browser errors captured";
      throw new Error(`React probe failed to load (${errDetail}): ${waitErr.message}`);
    }

    // Warmup
    if (warmupRuns > 0 && combos.length > 0) {
      await mountAndWaitProbe(page, combos[0]);
      for (let w = 0; w < warmupRuns; w++) {
        await rerenderProbe(page, combos[0]);
      }
    }

    // Portal orphan baseline (before any measurements)
    const portalBaseline = await countBodyOrphans(page);

    for (let ci = 0; ci < combos.length; ci++) {
      const props = combos[ci];

      // --- Memo bailout detection ---
      await resetProfilerData(page);
      await mountAndWaitProbe(page, props);
      await rerenderProbe(page, props);
      const snapA = await collectProfilerData(page);
      await rerenderProbe(page, props);
      const snapB = await collectProfilerData(page);
      const memoDiff = diffSnapshots(snapA, snapB);
      const memoBailoutComponents = detectMemoBailouts(memoDiff);

      // --- Context fan-out detection ---
      await resetProfilerData(page);
      await mountAndWaitProbe(page, props);
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
      const ctxSnapA = await collectProfilerData(page);
      await page.evaluate(() => (window as any).__120fps.forceContextUpdate());
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
      const ctxSnapB = await collectProfilerData(page);
      const ctxDiff = diffSnapshots(ctxSnapA, ctxSnapB);
      const contextFanOutComponents = detectContextFanOut(ctxDiff);

      // --- Callback identity detection ---
      const callbackIdentityDeltas: CallbackIdentityDelta[] = [];
      if (fnPropNames.length > 0) {
        for (const fnProp of fnPropNames) {
          const stableSamples: number[] = [];
          const freshSamples: number[] = [];

          for (let s = 0; s < samples; s++) {
            await tryCollectGarbage(cdp);
            await mountAndWaitProbe(page, props);
            const stableEvents = await collectTrace(cdp, async () => {
              await page.evaluate(
                ([p, names]: [any, string[]]) => (window as any).__120fps.rerenderWithStableCallbacks(p, names),
                [serializeProps(props), [fnProp]] as [Record<string, unknown>, string[]],
              );
              await page.evaluate(
                () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
              );
            });
            stableSamples.push(parseTraceDuration(stableEvents).totalDuration);
          }

          for (let s = 0; s < samples; s++) {
            await tryCollectGarbage(cdp);
            await mountAndWaitProbe(page, props);
            const freshEvents = await collectTrace(cdp, async () => {
              await page.evaluate(
                ([p, names]: [any, string[]]) => (window as any).__120fps.rerenderWithFreshCallbacks(p, names),
                [serializeProps(props), [fnProp]] as [Record<string, unknown>, string[]],
              );
              await page.evaluate(
                () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
              );
            });
            freshSamples.push(parseTraceDuration(freshEvents).totalDuration);
          }

          const delta = computeMedian(freshSamples) - computeMedian(stableSamples);
          if (delta > 0.5) {
            callbackIdentityDeltas.push({ propName: fnProp, deltaMs: delta });
          }
        }
      }

      // --- Render attribution ---
      const fullSnap = await collectProfilerData(page);
      const renderAttribution = computeRenderAttribution(fullSnap);

      // --- Portal orphan check ---
      const portalPost = await countBodyOrphans(page);
      const portalOrphans = computePortalOrphans(portalBaseline, portalPost);

      const opts: ReactOptimizations = {
        memoBailout: memoBailoutComponents.length > 0,
        contextFanOut: contextFanOutComponents.length > 0,
      };

      if (memoBailoutComponents.length > 0) opts.memoBailoutComponents = memoBailoutComponents;
      if (contextFanOutComponents.length > 0) opts.contextFanOutComponents = contextFanOutComponents;
      if (callbackIdentityDeltas.length > 0) opts.callbackIdentityDeltas = callbackIdentityDeltas;
      if (portalOrphans > 0) opts.portalOrphans = portalOrphans;
      if (renderAttribution.length > 0) opts.renderAttribution = renderAttribution;

      results.set(ci, opts);
    }

    return results;
  } finally {
    if (browser) await browser.close();
    try {
      fs.unlinkSync(path.join(harness.harnessDir, "probe-entry.tsx"));
      fs.unlinkSync(path.join(harness.harnessDir, "probe.html"));
    } catch { /* cleanup best-effort */ }
  }
}
