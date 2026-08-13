import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import { renderTreeHelper, setupApiBlock, setupBlock, wrapImportLine, type HarnessResult } from "./harness.js";
import type { PropCombination } from "./prop-gen-values.js";
import { applyWrapperViewport, collectTrace, parseTraceDuration, settleStyles, tryCollectGarbage, computeMedian, HARNESS_NAV_WAIT } from "./measure.js";
import { attachPageErrorCapture, enrichTimeoutError } from "./page-errors.js";

export interface FiberInfo {
  name: string;
  renderCount: number;
  actualDurationMs: number;
  selfDurationMs: number;
  descendantCount: number;
  isMemo: boolean;
}

export interface ProfilerSnapshot {
  fibers: Map<string, FiberInfo>;
  commitCount: number;
}

export interface ProfilerDiff {
  rerenderFibers: Array<{ name: string; renderCountDelta: number; isMemo: boolean }>;
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
  durationsUnavailable?: boolean;
  compilerActive?: boolean;
}

export function detectDurationsUnavailable(snapshot: {
  fibers: Map<string, { actualDurationMs?: number }>;
}): boolean {
  if (snapshot.fibers.size === 0) return false;
  for (const fiber of snapshot.fibers.values()) {
    const d = fiber.actualDurationMs;
    if (d !== undefined && d !== 0) return false;
  }
  return true;
}

export function detectFramework(projectRoot: string): "react" | "vanilla" {
  try {
    const raw = fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    if (typeof pkg !== "object" || pkg === null) return "react";
    for (const section of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
      if (section == null) continue;
      if (typeof section !== "object") return "react";
      if ("react" in section || "react-dom" in section) return "react";
    }
    return "vanilla";
  } catch {
    return "react";
  }
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
      rerenderFibers.push({ name: fiberB.name, renderCountDelta: delta, isMemo: fiberB.isMemo });
    }
  }
  rerenderFibers.sort((a, b) => b.renderCountDelta - a.renderCountDelta);
  return { rerenderFibers };
}

// Bundlers suffix duplicate function names (__120fpsStable → __120fpsStable2),
// so probe internals are matched by prefix rather than exact name.
function isProbeInternal(name: string): boolean {
  return name === "Root" || name === "AppRoot" || name.startsWith("__120fps");
}

// React Compiler emits memo-cache slot bindings (_c1, _c2, ...) that reach the
// fiber tree as names. They identify a cache index, not a component the user
// wrote, so acting on them is impossible.
function isCompilerCacheSlot(name: string): boolean {
  return /^_c\d+$/.test(name);
}

// A name worth showing the user: neither our own harness nor a compiler artifact.
function isReportableComponent(name: string): boolean {
  return !isProbeInternal(name) && !isCompilerCacheSlot(name);
}

// A component without React.memo re-renders whenever its parent does — that is
// React working as designed, not a defect. Only a memoized component that
// re-rendered on identical props has had its memoization defeated.
export function detectMemoBailouts(diff: ProfilerDiff): string[] {
  return diff.rerenderFibers
    .filter((f) => f.isMemo && isReportableComponent(f.name))
    .map((f) => f.name);
}

// The probe renders the component behind a memo boundary, so a value change on
// the synthetic provider reaches only fibers that actually read the context.
export function detectContextFanOut(diff: ProfilerDiff): string[] {
  return diff.rerenderFibers
    .filter((f) => isReportableComponent(f.name))
    .map((f) => f.name);
}

export function computeRenderAttribution(
  snapshot: ProfilerSnapshot,
  top = 5,
): RenderAttribution[] {
  // The probe's own provider and memo boundary are harness scaffolding, not the
  // user's components; reporting them as hot spots is noise.
  const fibers = [...snapshot.fibers.values()].filter((f) => isReportableComponent(f.name));
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

// Under the compiler, automatic memoization is the compiler's job: a bailout
// finding is not actionable user code, so it stays informational.
export function hasReactWarning(opts: ReactOptimizations): boolean {
  if (opts.memoBailout && !opts.compilerActive) return true;
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
  var lastSeen = {};
  var lastChild = {};
  var commitCount = 0;

  // React double-buffers: a fiber that took part in a render pass is a
  // different object than it was last commit, while a subtree that bailed out
  // is reused by reference. Walking the tree per commit therefore visits every
  // fiber, but only the ones whose identity changed actually rendered.
  function walkFiber(fiber, depth, path) {
    if (!fiber) return;
    var name = fiber.type
      ? (fiber.type.displayName || fiber.type.name || "Anonymous")
      : (fiber.tag === 3 ? "Root" : "Unknown");
    var id = path + "_" + name;

    var descendants = 0;
    var child = fiber.child;
    while (child) {
      descendants++;
      child = child.sibling;
    }

    var isMemo = fiber.tag === 14 || fiber.tag === 15;
    if (!fibers[id]) {
      fibers[id] = { name: name, renderCount: 0, actualDurationMs: 0, selfDurationMs: 0, descendantCount: descendants, isMemo: isMemo };
    }

    var rendered = lastSeen[id] !== fiber;
    // React clones a memo fiber even when it bails on equal props, so identity
    // alone would report every visited memo component as re-rendered. A real
    // bailout reuses the whole child subtree by reference.
    if (rendered && isMemo && fiber.child !== null && lastChild[id] === fiber.child) {
      rendered = false;
    }
    lastSeen[id] = fiber;
    lastChild[id] = fiber.child;

    if (rendered) {
      fibers[id].renderCount++;
      if (typeof fiber.actualDuration === "number") {
        fibers[id].actualDurationMs += fiber.actualDuration;
      }
      if (typeof fiber.selfBaseDuration === "number") {
        fibers[id].selfDurationMs += fiber.selfBaseDuration;
      }
    }
    fibers[id].descendantCount = descendants;

    if (fiber.child) walkFiber(fiber.child, depth + 1, path + ".0");
    if (fiber.sibling) walkFiber(fiber.sibling, depth, path + "s");
  }

  window.__120fps_profiler = {
    fibers: fibers,
    commitCount: 0,
    reset: function() {
      fibers = {};
      lastSeen = {};
      lastChild = {};
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
        walkFiber(root.current, 0, "r");
      }
    },
    onCommitFiberUnmount: function() {},
    onScheduleFiberRoot: function() {},
    onPostCommitFiberRoot: function() {}
  };
})();
`;

export async function injectProfilerHook(cdp: CDPSession): Promise<void> {
  // Page.addScriptToEvaluateOnNewDocument silently no-ops while the Page domain
  // is disabled, leaving every fiber snapshot empty.
  await cdp.send("Page.enable" as any);
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
      isMemo: f.isMemo === true,
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
  wrapRelative?: string;
}

export function generateProbeEntry(opts: ProbeEntryOptions): string {
  const importLine = opts.isDefaultExport
    ? `import ${opts.componentName} from "/${opts.componentRelative}";`
    : `import { ${opts.componentName} as Component } from "/${opts.componentRelative}";`;

  const componentRef = opts.isDefaultExport ? opts.componentName : "Component";

  return `
import { createElement, createContext, memo, useState, useCallback, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
${wrapImportLine(opts.wrapRelative)}${importLine}

const __120fpsContext = createContext(0);
__120fpsContext.displayName = "__120fpsProbeContext";

// The memo boundary keeps the provider's own re-render from cascading, so a
// value change reaches only fibers that actually read the context.
const __120fpsStable = memo(function __120fpsStable({ node }: { node: ReactNode }) {
  return node;
});

function __120fpsContextProbe({ children }: { children: ReactNode }) {
  const [value, setValue] = useState(0);
  (window as any).__120fps_forceContext = () => setValue((v: number) => v + 1);
  return createElement(
    __120fpsContext.Provider,
    { value },
    createElement(__120fpsStable, { node: children }),
  );
}

const container = document.getElementById("root")!;
let root = createRoot(container);
let mounted = false;
const stableCallbackCache = new Map<string, Function>();
${renderTreeHelper(opts.wrapRelative)}
${setupBlock(opts.wrapRelative)}
(window as any).__120fps = {
  mount(props: any = {}) {
    if (mounted) {
      root.unmount();
      root = createRoot(container);
    }
    renderTree(
      createElement(__120fpsContextProbe, null,
        createElement(${componentRef}, props)
      )
    );
    mounted = true;
  },
  mountWrapperOnly() {
    if (mounted) {
      root.unmount();
      root = createRoot(container);
    }
    renderTree(null);
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
    renderTree(
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
${setupApiBlock(opts.wrapRelative)}${probeViewportBlock(opts.wrapRelative)}
`;
}

function probeViewportBlock(wrapRelative?: string): string {
  if (!wrapRelative) return "";
  return `
const __120fpsViewport = (__120fpsWrapModule as any).viewport;
if (__120fpsViewport) (window as any).__120fps.viewport = __120fpsViewport;
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
  // M37: reuse the pooled vsync browser (fresh context per pass).
  pool?: import("./measure.js").BrowserPool;
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

  const probeEntry = generateProbeEntry({
    componentRelative: harness.component.relative,
    componentName: harness.component.name,
    isDefaultExport: harness.component.isDefaultExport,
    ...(harness.wrapRelative ? { wrapRelative: harness.wrapRelative } : {}),
  });

  const probeHtml = generateProbeHtml();

  fs.writeFileSync(path.join(harness.harnessDir, "probe-entry.tsx"), probeEntry);
  fs.writeFileSync(path.join(harness.harnessDir, "probe.html"), probeHtml);

  const harnessUrl = harness.url;
  const probeUrl = harnessUrl.replace(/\/$/, "/probe.html");

  const results = new Map<number, ReactOptimizations>();
  let browser: Browser | undefined;
  let context: import("playwright").BrowserContext | undefined;

  try {
    if (options.pool) {
      context = await (await options.pool.acquire(false)).newContext();
    } else {
      browser = await chromium.launch({ headless: true });
    }
    const page = context ? await context.newPage() : await browser!.newPage();
    const cdp = await page.context().newCDPSession(page);

    await injectProfilerHook(cdp);

    const errorCapture = attachPageErrorCapture(page);

    await page.goto(probeUrl, { timeout: 30000, waitUntil: HARNESS_NAV_WAIT });
    try {
      await page.waitForFunction(
        () => typeof (window as any).__120fps === "object",
        undefined,
        { timeout: 30000 },
      );
    } catch (waitErr) {
      throw enrichTimeoutError(waitErr, errorCapture, "react analysis harness");
    }

    await applyWrapperViewport(page);
    await settleStyles(page, harness);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });

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
      if (detectDurationsUnavailable(fullSnap)) opts.durationsUnavailable = true;
      if (harness.reactCompiler?.active) opts.compilerActive = true;

      results.set(ci, opts);
    }

    return results;
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    try {
      fs.unlinkSync(path.join(harness.harnessDir, "probe-entry.tsx"));
      fs.unlinkSync(path.join(harness.harnessDir, "probe.html"));
    } catch { /* cleanup best-effort */ }
  }
}
