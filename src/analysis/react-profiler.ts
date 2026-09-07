import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import type { HarnessResult } from "../harness/index.js";
import { generateProbeEntry, generateProbeHtml } from "./react-probe-entry.js";
import type { PropCombination } from "../props/index.js";
import { FUNCTION_MARKER, serializeProps } from "../props/index.js";
import { applyWrapperViewport, collectTrace, createPhaseTracker, harnessReadyTimeoutMs, parseTraceDuration, settleStyles, reportFontSettle, tryCollectGarbage, HARNESS_NAV_WAIT } from "../browser/index.js";
import { computeMedian, readJsonFile } from "../shared/index.js";
import {
  attachPageErrorCapture,
  enrichTimeoutError,
  gotoWithErrorContext,
} from "../browser/index.js";

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
  // A difference alone hides whether it is 6ms of 8ms or 6ms of 300ms.
  stableMs?: number;
  freshMs?: number;
}

// An A/A control on a 900-node memoized fixture showed +18.1ms and +30.9ms apparent effects.
const CALLBACK_IDENTITY_MIN_DELTA_MS = 0.5;

export function computeCallbackIdentityDelta(
  stableSamples: number[],
  freshSamples: number[],
): { deltaMs: number; stableMs: number; freshMs: number } | null {
  if (stableSamples.length < 2 || freshSamples.length < 2) return null;

  const stableMs = computeMedian(stableSamples);
  const freshMs = computeMedian(freshSamples);
  const deltaMs = freshMs - stableMs;
  if (deltaMs <= CALLBACK_IDENTITY_MIN_DELTA_MS) return null;

  const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
  // An effect smaller than the two arms' spreads together is baseline drift and nothing else.
  if (deltaMs <= spread(stableSamples) + spread(freshSamples)) return null;

  return { deltaMs, stableMs, freshMs };
}

// A capture-phase prop is the same function on the same element as its bubble twin, so probing
// both measures one thing twice. One without a twin in the list is the only handler there is.
export function probedFunctionProps(fnPropNames: string[]): string[] {
  const declared = new Set(fnPropNames);
  return fnPropNames.filter(
    (name) => !(name.endsWith("Capture") && declared.has(name.slice(0, -"Capture".length))),
  );
}

// Key order is what the generator happened to emit, so equal props sort to one key.
// __120fps_scaleN is a harness trigger key the probe entry has no branch for, so combos that
// differ only in it mount the same single instance with the same props.
export function propCombinationKey(props: PropCombination): string {
  const serialized = serializeProps(props) as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(serialized)
      .filter((name) => name !== "__120fps_scaleN")
      .sort()
      .map((name) => [name, serialized[name]]),
  );
}

// Combos that share a key are the same measurement to the probe, so one pass answers for all of
// them; every combo still gets its own entry, and the combo list itself is untouched.
export async function measureOncePerPropSet<T>(
  combos: PropCombination[],
  measure: (props: PropCombination, comboIndex: number) => Promise<T>,
): Promise<Map<number, T>> {
  const measured = new Map<string, T>();
  const byCombo = new Map<number, T>();
  for (let ci = 0; ci < combos.length; ci++) {
    const key = propCombinationKey(combos[ci]);
    if (!measured.has(key)) measured.set(key, await measure(combos[ci], ci));
    byCombo.set(ci, measured.get(key)!);
  }
  return byCombo;
}

// What one arm of the callback-identity probe needs from the page; a fake bounds the pass's work.
export interface CallbackProbePort {
  collectGarbage(): Promise<void>;
  // Every arm mounts fresh, so only the measured prop's identity differs between the two arms.
  mountWithStableCallbacks(fnProp: string): Promise<void>;
  measureRerender(fnProp: string, fresh: boolean): Promise<number>;
}

export async function measureCallbackIdentityDeltas(
  port: CallbackProbePort,
  fnPropNames: string[],
  samples: number,
): Promise<CallbackIdentityDelta[]> {
  const deltas: CallbackIdentityDelta[] = [];
  for (const fnProp of probedFunctionProps(fnPropNames)) {
    const stableSamples: number[] = [];
    const freshSamples: number[] = [];

    // Once per probed prop: the alternation below is what holds the two arms against drift.
    await port.collectGarbage();

    const measureArm = async (fresh: boolean, sink: number[]) => {
      await port.mountWithStableCallbacks(fnProp);
      sink.push(await port.measureRerender(fnProp, fresh));
    };

    // Arms alternate, so a baseline drifting over the pass does not land on one arm.
    for (let s = 0; s < samples; s++) {
      if (s % 2 === 0) {
        await measureArm(false, stableSamples);
        await measureArm(true, freshSamples);
      } else {
        await measureArm(true, freshSamples);
        await measureArm(false, stableSamples);
      }
    }

    const delta = computeCallbackIdentityDelta(stableSamples, freshSamples);
    if (delta) deltas.push({ propName: fnProp, ...delta });
  }
  return deltas;
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

// Bundlers suffix duplicate function names, so probe internals are matched by prefix.
function isProbeInternal(name: string): boolean {
  return name === "Root" || name === "AppRoot" || name.startsWith("__120fps");
}

// React Compiler memo-cache slots (_c1, _c2) reach the fiber tree as names; nothing to act on.
function isCompilerCacheSlot(name: string): boolean {
  return /^_c\d+$/.test(name);
}

// A name worth showing the user: neither our own harness nor a compiler artifact.
function isReportableComponent(name: string): boolean {
  return !isProbeInternal(name) && !isCompilerCacheSlot(name);
}

// A component without memo re-renders with its parent by design; only a memoized one qualifies.
export function detectMemoBailouts(diff: ProfilerDiff): string[] {
  return diff.rerenderFibers
    .filter((f) => f.isMemo && isReportableComponent(f.name))
    .map((f) => f.name);
}

// The filter detectMemoBailouts applies, asked of the tree instead of of a diff over it.
export function snapshotHasMemoFiber(snapshot: ProfilerSnapshot): boolean {
  for (const fiber of snapshot.fibers.values()) {
    if (fiber.isMemo && isReportableComponent(fiber.name)) return true;
  }
  return false;
}

// The second render the memo diff needs; the first snapshot is one the pass already took.
export interface MemoProbePort {
  rerenderAndCollect(): Promise<ProfilerSnapshot>;
}

// A tree with no memoized fiber has no bailout to find, and the diff would say so at a full
// render's cost.
export async function detectMemoBailoutsFromSnapshot(
  snapshot: ProfilerSnapshot,
  probe: MemoProbePort,
): Promise<string[]> {
  if (!snapshotHasMemoFiber(snapshot)) return [];
  return detectMemoBailouts(diffSnapshots(snapshot, await probe.rerenderAndCollect()));
}

// The probe's memo boundary means only fibers that actually read the context re-render.
export function detectContextFanOut(diff: ProfilerDiff): string[] {
  return diff.rerenderFibers
    .filter((f) => isReportableComponent(f.name))
    .map((f) => f.name);
}

export function computeRenderAttribution(
  snapshot: ProfilerSnapshot,
  top = 5,
): RenderAttribution[] {
  // The probe's provider and memo boundary are harness scaffolding; reporting them is noise.
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

// Under the compiler, memoization is the compiler's job, so a bailout stays informational.
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

// Source rather than a closure: the hook is injected as text and unit tests evaluate it directly.
export const FIBER_TYPE_NAME_SOURCE = `function resolveTypeName(type, depth) {
  if (!type || depth > 4) return null;
  if (typeof type === "string") return type;
  var direct = type.displayName || type.name;
  if (direct) return direct;
  // memo -> .type, forwardRef -> .render. lazy/context carry neither and stop.
  var inner = type.type || type.render;
  if (!inner) return null;
  return resolveTypeName(inner, depth + 1);
}`;

export const PROFILER_HOOK_SCRIPT = `
(function() {
  ${FIBER_TYPE_NAME_SOURCE}

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
      ? (resolveTypeName(fiber.type, 0) || "Anonymous")
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
  // addScriptToEvaluateOnNewDocument silently no-ops while the Page domain is disabled.
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

export interface ReactAnalysisOptions {
  combos: PropCombination[];
  samples?: number;
  cpuThrottle?: number;
  warmupRuns?: number;
  fnPropNames?: string[];
  // Reuse the pooled vsync browser (fresh context per pass).
  pool?: import("../browser/index.js").BrowserPool;
  // This pass settles fonts on its own probe page, so a timeout here needs its own way out.
  onWarning?: (warning: string) => void;
}

export interface ReactDomIdentity {
  name: string;
  version: string;
  // "vite-alias" when a resolve.alias match supplied the identity, which has a different remedy.
  source?: "vite-alias";
}

// The aliased file's own package.json: a resolve.alias match is what this server actually mounts.
function nearestPackageJson(fromPath: string): { name?: unknown; version?: unknown } | undefined {
  let dir: string;
  try {
    dir = fs.statSync(fromPath).isDirectory() ? fromPath : path.dirname(fromPath);
  } catch {
    dir = path.dirname(fromPath);
  }
  while (true) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      return readJsonFile(candidate) as { name?: unknown; version?: unknown } | undefined;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function resolveViaBundlerAlias(
  bundlerAliases: Array<{ find: RegExp; replacement: string }>,
): ReactDomIdentity | undefined {
  for (const entry of bundlerAliases) {
    if (!entry.find.test("react-dom") && !entry.find.test("react-dom/client")) continue;
    const pkg = nearestPackageJson(entry.replacement);
    if (pkg && typeof pkg.name === "string" && typeof pkg.version === "string") {
      return { name: pkg.name, version: pkg.version, source: "vite-alias" };
    }
  }
  return undefined;
}

// An npm alias keeps the react-dom folder name; only its package.json's name tells them apart.
export function resolveReactDomIdentity(
  fromDir: string,
  bundlerAliases: Array<{ find: RegExp; replacement: string }> = [],
): ReactDomIdentity | undefined {
  // A bundler alias wins: when one matches, it is what this server actually mounts.
  const viaAlias = resolveViaBundlerAlias(bundlerAliases);
  if (viaAlias) return viaAlias;
  try {
    // fromDir sits under the project root (harness/dirs.ts), so Node's walk finds the install.
    const projectRequire = createRequire(path.join(fromDir, "/"));
    const pkgPath = projectRequire.resolve("react-dom/package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { name?: unknown; version?: unknown };
    if (typeof pkg.name !== "string" || typeof pkg.version !== "string") return undefined;
    return { name: pkg.name, version: pkg.version };
  } catch {
    return undefined;
  }
}

const REACT_DOM_MIN_MAJOR = 16;
const REACT_DOM_MIN_MINOR = 5;
const REACT_DOM_MAX_MAJOR = 19;

// PROFILER_HOOK_SCRIPT hardcodes React's WorkTag numbers (memo=14, forwardRef=15) for this range.
export function isSupportedReactDomVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version);
  // An unparseable version is evidence of nothing, so it passes.
  if (!match) return true;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < REACT_DOM_MIN_MAJOR) return false;
  if (major === REACT_DOM_MIN_MAJOR && minor < REACT_DOM_MIN_MINOR) return false;
  return major <= REACT_DOM_MAX_MAJOR;
}

export const REACT_DOM_NOT_REACT_WARNING = (identity: ReactDomIdentity | undefined): string => {
  if (identity?.source === "vite-alias") {
    return (
      `react-dom resolves to "${identity.name}" via this project's vite.config.ts resolve.alias, ` +
      "not the installed react-dom package; skipping React fiber analysis (memo bailout, context " +
      "fan-out, callback identity, render attribution). The component still mounts and is " +
      "measured normally."
    );
  }
  return identity
    ? `react-dom resolves to "${identity.name}", not react-dom (an npm alias such as ` +
      `"react-dom": "npm:preact/compat" resolves this way); skipping React fiber analysis ` +
      "(memo bailout, context fan-out, callback identity, render attribution). The component " +
      "still mounts and is measured normally."
    : "could not resolve react-dom's package.json to confirm its identity; skipping React fiber " +
      "analysis (memo bailout, context fan-out, callback identity, render attribution) since it " +
      "may not be React. The component still mounts and is measured normally.";
};

export const REACT_DOM_VERSION_RANGE_WARNING = (version: string): string =>
  `react-dom ${version} is outside 120fps's tested range (16.5-19); the fiber profiler hardcodes ` +
  "React's internal WorkTag numbers for that range and may misreport render counts or durations.";

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

// The stable arm's re-render changes nothing; the fresh arm's changes exactly one identity.
async function mountWithStableCallbacksProbe(
  page: Page,
  props: PropCombination,
  measured: string,
): Promise<void> {
  await page.evaluate(() => (window as any).__120fps.unmount());
  await page.evaluate(
    ([p, name]: [any, string]) =>
      (window as any).__120fps.mountWithStableCallbacks(p, name),
    [serializeProps(props), measured] as [Record<string, unknown>, string],
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

  // detectFramework accepts an npm alias that is not React; fiber reads need a confirmed identity.
  const reactDomIdentity = resolveReactDomIdentity(harness.harnessDir, harness.viteAliases ?? []);
  if (!reactDomIdentity || reactDomIdentity.name !== "react-dom") {
    options.onWarning?.(REACT_DOM_NOT_REACT_WARNING(reactDomIdentity));
    // Mounting is unaffected: harness/entry.ts uses createRoot, which preact/compat implements.
    return new Map();
  }
  if (!isSupportedReactDomVersion(reactDomIdentity.version)) {
    options.onWarning?.(REACT_DOM_VERSION_RANGE_WARNING(reactDomIdentity.version));
  }

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
  // This pass owns the probe page and its own tracing windows; a crash here has no other phase.
  const inFlight = createPhaseTracker("attribution", harness);

  try {
    return await inFlight.run(async () => {
    if (options.pool) {
      context = await (await options.pool.acquire(false)).newContext();
    } else {
      browser = await chromium.launch({ headless: true });
    }
    const page = context ? await context.newPage() : await browser!.newPage();
    const cdp = await page.context().newCDPSession(page);

    await injectProfilerHook(cdp);

    const errorCapture = attachPageErrorCapture(page, path.basename(harness.harnessDir));

    // One read for both waits: navigation and readiness are one arrival, so one bound covers them.
    const readyTimeoutMs = harnessReadyTimeoutMs();

    await gotoWithErrorContext(page, probeUrl, errorCapture, "react analysis harness", {
      timeout: readyTimeoutMs,
      waitUntil: HARNESS_NAV_WAIT,
    });
    try {
      await page.waitForFunction(
        () => typeof (window as any).__120fps === "object",
        undefined,
        { timeout: readyTimeoutMs },
      );
    } catch (waitErr) {
      throw enrichTimeoutError(waitErr, errorCapture, "react analysis harness");
    }

    await applyWrapperViewport(page);
    reportFontSettle(await settleStyles(page, harness), options.onWarning);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });

    if (warmupRuns > 0 && combos.length > 0) {
      await mountAndWaitProbe(page, combos[0]);
      for (let w = 0; w < warmupRuns; w++) {
        await rerenderProbe(page, combos[0]);
      }
    }

    // Read before any measurement: a later baseline would hide the orphans this pass creates.
    const portalBaseline = await countBodyOrphans(page);

    const byCombo = await measureOncePerPropSet(combos, async (props, ci) => {
      inFlight.combo = ci;

      // One window for the render attribution and the memo diff's first snapshot: the two ask for
      // the same mount, and it is taken before the callback arms so the counts describe the
      // component.
      await resetProfilerData(page);
      await mountAndWaitProbe(page, props);
      await rerenderProbe(page, props);
      const fullSnap = await collectProfilerData(page);
      const renderAttribution = computeRenderAttribution(fullSnap);

      const memoBailoutComponents = await detectMemoBailoutsFromSnapshot(fullSnap, {
        rerenderAndCollect: async () => {
          await rerenderProbe(page, props);
          return await collectProfilerData(page);
        },
      });

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

      const callbackIdentityDeltas = await measureCallbackIdentityDeltas(
        {
          collectGarbage: async () => {
            await tryCollectGarbage(cdp);
          },
          mountWithStableCallbacks: (fnProp) =>
            mountWithStableCallbacksProbe(page, props, fnProp),
          measureRerender: async (fnProp, fresh) => {
            const events = await collectTrace(cdp, async () => {
              await page.evaluate(
                ([p, name, isFresh]: [any, string, boolean]) =>
                  (window as any).__120fps[
                    isFresh ? "rerenderWithFreshCallbacks" : "rerenderWithStableCallbacks"
                  ](p, name),
                [serializeProps(props), fnProp, fresh] as [
                  Record<string, unknown>,
                  string,
                  boolean,
                ],
              );
              await page.evaluate(
                () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
              );
            });
            return parseTraceDuration(events).totalDuration;
          },
        },
        fnPropNames,
        samples,
      );

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

      return opts;
    });

    // A fresh top-level object per combo, so the report writes each combo's findings under its own
    // key. The arrays inside are shared, which is safe: nothing writes to a result after this loop.
    for (const [ci, opts] of byCombo) results.set(ci, { ...opts });

    return results;
    });
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    try {
      fs.unlinkSync(path.join(harness.harnessDir, "probe-entry.tsx"));
      fs.unlinkSync(path.join(harness.harnessDir, "probe.html"));
    } catch { /* cleanup best-effort */ }
  }
}
