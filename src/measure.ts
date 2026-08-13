import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import type { HarnessResult } from "./harness.js";
import type { PropCombination } from "./prop-gen-values.js";
import { extractProps } from "./prop-gen.js";
import { generateCombinations } from "./prop-gen-values.js";
import { attachPageErrorCapture, enrichTimeoutError, type PageErrorCapture } from "./page-errors.js";

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

// `document.querySelectorAll("*")` counts html/head/body/#root and Vite's
// injected scripts, an ~8 element floor that is not the component's DOM and
// that pushed small components a whole tier up. Count what the component
// actually rendered: everything inside #root, plus portal content, which lives
// on document.body but belongs to the component.
export async function countComponentNodes(page: Page): Promise<number> {
  return page.evaluate(() => {
    const INTERNAL = new Set(["SCRIPT", "STYLE", "LINK", "NOSCRIPT", "TEMPLATE"]);
    const root = document.getElementById("root");
    let count = root ? root.querySelectorAll("*").length : 0;
    for (const child of Array.from(document.body.children)) {
      if (child === root) continue;
      if (INTERNAL.has(child.tagName)) continue;
      if (child.localName.startsWith("vite-")) continue;
      count += 1 + child.querySelectorAll("*").length;
    }
    return count;
  });
}

// M40: what scene the numbers describe. A component that fetches, suspends, or
// defers work renders a fallback first, and a mount measurement over that scene
// is a real number about the wrong thing.
export type MeasuredState = "settled" | "pending-network" | "late-mutation";

// Grace window held after the mount fence, in real time: long enough for a
// promise-resolution or short-timer re-render to land, short enough that every
// combo can pay it once. Timers run on wall clock under the M35 frame pump, and
// the pump keeps driving frames throughout, so rAF-scheduled updates land too.
export const MEASURED_STATE_HOLD_MS = 120;

// Animation mutates the DOM by design, so an animated combo's mutation says
// nothing about settledness. The network signal is unaffected by it, and it
// names a cause the mutation signal only hints at, so it wins when both fire.
export function classifyMeasuredState(signals: {
  pendingNetwork: boolean;
  mutated: boolean;
  hasAnimation: boolean;
}): MeasuredState {
  if (signals.pendingNetwork) return "pending-network";
  if (signals.mutated && !signals.hasAnimation) return "late-mutation";
  return "settled";
}

// Counts in-flight fetch/XHR by wrapping the page's own APIs rather than
// enabling CDP's Network domain: the domain's event traffic lands inside traced
// windows, and enabling it for the probing sample only would make that sample's
// conditions differ from the rest of the median. The wrapper is installed once
// per page, before anything mounts, so every sample runs under identical
// instrumentation and the counters are read outside traced windows.
//
// Each request carries a monotonic id, so "pending" can be narrowed to requests
// that started during the mount rather than leftovers from an earlier combo.
const MEASURED_STATE_PROBE = `(() => {
  const w = window;
  if (w.__120fpsNet) return;
  const state = { started: 0, pending: new Set() };
  w.__120fpsNet = state;
  const track = (settled) => {
    const id = ++state.started;
    state.pending.add(id);
    settled.then(() => state.pending.delete(id), () => state.pending.delete(id));
  };
  const origFetch = w.fetch;
  if (typeof origFetch === "function") {
    w.fetch = function (...args) {
      // A synchronous throw never started a request, so it is never tracked.
      const p = origFetch.apply(this, args);
      track(p);
      return p;
    };
  }
  const XHR = w.XMLHttpRequest;
  if (typeof XHR === "function" && XHR.prototype && XHR.prototype.send) {
    const send = XHR.prototype.send;
    XHR.prototype.send = function (...args) {
      // The listener goes on before send: a synchronous XHR fires loadend
      // inside send(), and attaching afterwards would miss it forever.
      let settle;
      const done = new Promise((resolve) => { settle = resolve; });
      this.addEventListener("loadend", () => settle(), { once: true });
      track(done);
      try {
        return send.apply(this, args);
      } catch (err) {
        // send never started, so no loadend is coming.
        settle();
        throw err;
      }
    };
  }
})()`;

export async function installMeasuredStateProbe(page: Page): Promise<void> {
  await page.evaluate(MEASURED_STATE_PROBE);
}

export async function readNetworkProbe(
  page: Page,
): Promise<{ started: number; pending: number[] }> {
  return page.evaluate(() => {
    const state = (window as any).__120fpsNet;
    if (!state) return { started: 0, pending: [] as number[] };
    return { started: state.started as number, pending: [...state.pending] as number[] };
  });
}

const MUTATION_WATCH_KEY = "__120fpsMut";

// Armed the moment the mount fence clears, before the DOM-count and animation
// probes run. Those probes cost real time under a CPU throttle, and a component
// whose content arrives while they are running would otherwise be classified
// settled because our own instrumentation ate the window.
export async function beginMutationWatch(page: Page): Promise<void> {
  await page.evaluate((key: string) => {
    const w = window as any;
    if (w[key]?.observer) w[key].observer.disconnect();

    const INTERNAL = new Set(["SCRIPT", "STYLE", "LINK", "NOSCRIPT", "TEMPLATE"]);
    const root = document.getElementById("root");
    const state = { mutated: false, observer: null as MutationObserver | null };
    w[key] = state;

    const observer = new MutationObserver(() => {
      state.mutated = true;
    });
    state.observer = observer;
    const options = {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    };
    if (root) observer.observe(root, options);
    for (const child of Array.from(document.body.children)) {
      if (child === root) continue;
      if (INTERNAL.has(child.tagName)) continue;
      if (child.localName.startsWith("vite-")) continue;
      observer.observe(child, options);
    }
    // A portal that appears late is a body-level childList change, which the
    // per-child observers above cannot see.
    observer.observe(document.body, { childList: true });
  }, MUTATION_WATCH_KEY);
}

// Holds the remainder of the grace window, then reports what moved. The hold
// runs whether or not the mutation signal applies to this combo: the network
// signal reads after the same window either way.
export async function endMutationWatch(page: Page, holdMs: number): Promise<boolean> {
  return page.evaluate(
    async ([key, ms]: [string, number]) => {
      await new Promise((r) => setTimeout(r, ms));
      const state = (window as any)[key];
      if (!state) return false;
      state.observer?.disconnect();
      state.observer = null;
      return state.mutated === true;
    },
    [MUTATION_WATCH_KEY, holdMs] as [string, number],
  );
}

// Begin, hold, end — the composed form, for callers that have nothing to do in
// between.
export async function probeLateMutation(
  page: Page,
  holdMs: number,
  observe: boolean,
): Promise<boolean> {
  if (!observe) {
    await page.evaluate((ms: number) => new Promise((r) => setTimeout(r, ms)), holdMs);
    return false;
  }
  await beginMutationWatch(page);
  return endMutationWatch(page, holdMs);
}

// Returns whether the CDP call succeeded; callers that only want best-effort
// cleanup ignore it.
export async function tryCollectGarbage(cdp: CDPSession): Promise<boolean> {
  try {
    await cdp.send("HeapProfiler.collectGarbage" as any);
    return true;
  } catch {
    return false;
  }
}

// M34: inter-sample bookkeeping (GC) produces no measured value, so it runs
// unthrottled; the throttle is restored before the next traced window. Errors
// propagate: call sites sit inside withContextRetry, whose re-entry re-engages
// the throttle. Nothing may run at an unknown throttle state.
export async function suspendThrottle<T>(
  cdp: CDPSession,
  rate: number,
  fn: () => Promise<T>,
): Promise<T> {
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  try {
    return await fn();
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  }
}

// Read from the page, not from Node: the wrapper module may import CSS and
// browser-only packages, so its `viewport` export only exists in the browser.
export async function applyWrapperViewport(page: Page): Promise<void> {
  const viewport = await page.evaluate(
    () => (window as any).__120fps?.viewport as { width?: unknown; height?: unknown } | undefined,
  );
  if (!viewport) return;
  const { width, height } = viewport;
  if (typeof width !== "number" || typeof height !== "number") return;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return;
  await page.setViewportSize({ width: Math.round(width), height: Math.round(height) });
}

// The readiness gate is window.__120fps, not the load event. A stylesheet whose
// webfont never answers keeps `load` pending forever, which would fail the
// navigation before the settle gate gets a chance to bound it.
export const HARNESS_NAV_WAIT = "domcontentloaded" as const;

export const FONT_SETTLE_TIMEOUT_MS = 5000;
export const FONT_SETTLE_WARNING = "font loading did not settle within 5s";

type StyledHarness = Pick<HarnessResult, "cssFiles" | "wrapRelative">;

// A wrapper module imports stylesheets and fonts at module evaluation time just
// like --css does, so both arm the gate.
export function needsStyleSettle(harness: StyledHarness): boolean {
  return (harness.cssFiles?.length ?? 0) > 0 || harness.wrapRelative !== undefined;
}

// Runs after window.__120fps exists and before any calibration, warmup, or
// sample, so the first measurement does not absorb font and stylesheet
// application cost. Returns false when fonts did not settle within the bound.
export async function settleStyles(
  page: Page,
  harness: StyledHarness,
): Promise<boolean> {
  if (!needsStyleSettle(harness)) return true;
  return page.evaluate(async (timeoutMs: number) => {
    const fonts = (document as unknown as { fonts?: { ready?: Promise<unknown> } }).fonts;
    let settled = true;
    if (fonts?.ready) {
      settled = await Promise.race([
        fonts.ready.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ]);
    }
    document.body.getBoundingClientRect();
    // Bounded like rafFence: in a begin-frame-controlled browser a dead pump
    // would otherwise hang this fence forever.
    await new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("frame starvation: style settle fence exceeded 10000ms")),
        10_000,
      );
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          clearTimeout(t);
          resolve(undefined);
        }),
      );
    });
    return settled;
  }, FONT_SETTLE_TIMEOUT_MS);
}

const HARNESS_READY_TIMEOUT_MS = 30000;

export interface HarnessSessionOptions {
  // Names the session in a readiness-timeout error.
  label: string;
  cpuThrottle?: number;
  // Appended to the harness URL, e.g. "?strict=1".
  search?: string;
  // M35: "vsync" opts a pass out of begin-frame control (animated combos).
  pacing?: "driven" | "vsync";
  // M37: reuse pooled browsers (fresh context per session).
  pool?: BrowserPool;
  onWarning?: (warning: string) => void;
}

// Navigate and bring the page to a measurable state: readiness gate, wrapper
// viewport, style/font settle, CPU throttle. Re-runnable, so a pass that
// navigates mid-session repeats the whole preamble.
export async function enterHarness(
  page: Page,
  cdp: CDPSession,
  harness: HarnessResult,
  errorCapture: PageErrorCapture,
  options: HarnessSessionOptions,
): Promise<void> {
  const url = harness.url + (options.search ?? "");
  await page.goto(url, { waitUntil: HARNESS_NAV_WAIT });
  try {
    await page.waitForFunction(
      () => typeof (window as any).__120fps === "object",
      undefined,
      { timeout: HARNESS_READY_TIMEOUT_MS },
    );
  } catch (err) {
    throw enrichTimeoutError(err, errorCapture, options.label);
  }

  await applyWrapperViewport(page);
  // Before any mount, so every sample runs under the same instrumentation.
  await installMeasuredStateProbe(page);
  await settleStyles(page, harness);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: options.cpuThrottle ?? 4 });
}

export const CONTEXT_RETRY_WARNING =
  "the dev server reloaded the page mid-measurement; the affected sample was retried once";

// Promoted to user-facing text (M56): the retry above absorbs one reload, but
// exhausting the shared budget means the pattern kept recurring across the
// run — that points at the environment, not the component under test.
export const RETRY_BUDGET_EXHAUSTED_NOTE =
  " The context-retry budget is exhausted: repeated dev-server reloads (environment), not the " +
  "component, are the likely cause.";

// Vite's dependency optimizer can full-reload the page while a sample is in
// flight. Two signatures, one cause: the evaluation context and the control API
// living on it disappear together.
//
// A tracing timeout leaves the CDP session wedged: the next `Tracing.start`
// answers "already been started". It is retryable only because `enter` now
// replaces the session rather than merely re-navigating (M33 E4).
const CONTEXT_LOST = [
  /Execution context was destroyed/i,
  /Cannot read properties of undefined \(reading '(mount|unmount|rerender|mountWrapperOnly|getContainer)'\)/i,
  /__120fps.*(undefined|not a function)/i,
  /Tracing\.tracingComplete timed out/i,
  /Target (page|closed|crashed)/i,
];

// The session is held in a box so `enter` can swap it and every body sees the
// replacement; a captured const would keep using the wedged one.
export interface CdpHolder {
  cdp: CDPSession;
}

export async function refreshCdpSession(page: Page, holder: CdpHolder): Promise<void> {
  try {
    await holder.cdp.detach();
  } catch {
    // Already detached, or the page went with it.
  }
  holder.cdp = await page.context().newCDPSession(page);
}

// M35: headless Chromium paces rAF at 60 Hz no matter what, so every traced
// window paid ~33 ms of vsync idle per double-rAF fence. With begin-frame
// control the compositor produces frames when told to; the pump tells it to,
// back-to-back, so a fence costs one protocol round trip (~2 ms) instead of
// two vsync ticks. Frames still happen — driven, not scheduled — so samples
// stay paint-inclusive.
export const MEASUREMENT_BROWSER_ARGS = [
  "--enable-begin-frame-control",
  "--run-all-compositor-stages-before-draw",
];

export const FRAME_PUMP_WARNING =
  "begin-frame control unavailable; measurement ran under vsync pacing (slower, semantics unchanged)";

// A begin-frame-controlled browser produces no frames without the pump, so a
// hung fence means a dead pump, not a slow component. The watchdog turns that
// hang into a failed run instead of an infinite wait.
const RAF_FENCE_TIMEOUT_MS = 10_000;

export async function rafFence(page: Page): Promise<void> {
  await page.evaluate(
    (timeoutMs: number) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error(`frame starvation: rAF fence exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            clearTimeout(t);
            resolve();
          }),
        );
      }),
    RAF_FENCE_TIMEOUT_MS,
  );
}

// Structural subset of CDPSession so the pump is testable without a browser.
interface FramePumpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface FramePump {
  stop(): Promise<void>;
  readonly disabled: boolean;
}

// Navigations make beginFrame fail transiently, so the error threshold is
// generous: a pump that dies for real is caught by the rAF fence watchdog,
// not by this counter. The holder is read on every frame so the pump follows
// refreshCdpSession onto the replacement session.
const PUMP_MAX_CONSECUTIVE_ERRORS = 120;
const PUMP_BACKOFF_MS = 5;

export function createFramePump(
  holder: { cdp: FramePumpSession },
  options: {
    maxConsecutiveErrors?: number;
    backoffMs?: number;
    onDisable?: () => void;
  } = {},
): FramePump {
  const {
    maxConsecutiveErrors = PUMP_MAX_CONSECUTIVE_ERRORS,
    backoffMs = PUMP_BACKOFF_MS,
    onDisable,
  } = options;
  let running = true;
  let disabled = false;

  const loop = (async () => {
    let consecutive = 0;
    while (running) {
      try {
        await holder.cdp.send("HeadlessExperimental.beginFrame", {});
        consecutive = 0;
      } catch {
        consecutive++;
        if (consecutive >= maxConsecutiveErrors) {
          disabled = true;
          running = false;
          onDisable?.();
          return;
        }
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  })();

  return {
    get disabled() {
      return disabled;
    },
    stop: async () => {
      running = false;
      await loop;
    },
  };
}

export type MeasurementPacing = "driven" | "vsync";

// M37: browser processes are project-agnostic; what a phase needs fresh is
// page state, and a new context delivers that (its pages get their own
// renderer process — V8 as cold as in a fresh browser). The pool holds at
// most one driven and one vsync Chromium for its lifetime.
export interface BrowserPool {
  acquire(driven: boolean): Promise<Browser>;
  stats(): { launched: number };
  closeAll(): Promise<void>;
}

export function createBrowserPool(
  launcher: (args: string[]) => Promise<Browser> = (args) =>
    chromium.launch({ headless: true, args }),
): BrowserPool {
  const browsers = new Map<string, Promise<Browser>>();
  let closed = false;
  let launched = 0;
  return {
    async acquire(driven: boolean) {
      if (closed) throw new Error("browser pool is closed");
      const key = driven ? "driven" : "vsync";
      let entry = browsers.get(key);
      if (!entry) {
        launched++;
        entry = launcher(driven ? MEASUREMENT_BROWSER_ARGS : []);
        browsers.set(key, entry);
      }
      return entry;
    },
    stats: () => ({ launched }),
    async closeAll() {
      closed = true;
      for (const entry of browsers.values()) {
        try {
          await (await entry).close();
        } catch {
          // Already gone with the process.
        }
      }
      browsers.clear();
    },
  };
}

// M41: the wrapper's session-scoped counterpart to setup, run once before the
// session's page goes away. Best-effort — a completed measurement must not fail
// because a teardown threw or the page was already gone.
export async function runWrapperTeardown(page: Page): Promise<void> {
  try {
    await page.evaluate(() => (window as any).__120fps?.teardown?.());
  } catch {
    // Page closed, context destroyed, or the wrapper's teardown threw.
  }
}

export interface MeasurementSession {
  browser: Browser;
  page: Page;
  errorCapture: PageErrorCapture;
  session: CdpHolder;
  pacing: MeasurementPacing;
  close(): Promise<void>;
}

// Begin-frame control is probed with one frame before anything else runs: a
// browser whose compositor cannot be driven never produces a frame at all, so
// probe failure falls the whole pass back to a plain vsync launch instead of
// hanging on the first fence.
export async function openMeasurementSession(options: {
  driven: boolean;
  onWarning?: (warning: string) => void;
  pool?: BrowserPool;
}): Promise<MeasurementSession> {
  // With a pool the session owns a context; without one it owns the browser.
  const open = async (driven: boolean) => {
    if (options.pool) {
      const browser = await options.pool.acquire(driven);
      const context = await browser.newContext();
      const page = await context.newPage();
      return { browser, page, dispose: () => context.close() };
    }
    const browser = await chromium.launch({
      headless: true,
      args: driven ? MEASUREMENT_BROWSER_ARGS : [],
    });
    const page = await browser.newPage();
    return { browser, page, dispose: () => browser.close() };
  };

  if (options.driven) {
    const { browser, page, dispose } = await open(true);
    try {
      const errorCapture = attachPageErrorCapture(page);
      const cdp = await page.context().newCDPSession(page);
      const holder: CdpHolder = { cdp };
      await cdp.send("HeadlessExperimental.beginFrame" as never, {} as never);
      const pump = createFramePump(holder, {
        onDisable: () => options.onWarning?.(FRAME_PUMP_WARNING),
      });
      return {
        browser,
        page,
        errorCapture,
        session: holder,
        pacing: "driven",
        close: async () => {
          await pump.stop();
          await runWrapperTeardown(page);
          await dispose();
        },
      };
    } catch {
      options.onWarning?.(FRAME_PUMP_WARNING);
      await dispose();
    }
  }

  const { browser, page, dispose } = await open(false);
  const errorCapture = attachPageErrorCapture(page);
  const cdp = await page.context().newCDPSession(page);
  return {
    browser,
    page,
    errorCapture,
    session: { cdp },
    pacing: "vsync",
    close: async () => {
      await runWrapperTeardown(page);
      await dispose();
    },
  };
}

export function isContextLostError(err: unknown): boolean {
  const message =
    typeof err === "string" ? err : err instanceof Error ? err.message : "";
  if (!message) return false;
  return CONTEXT_LOST.some((pattern) => pattern.test(message));
}

export interface RetryBudget {
  remaining: number;
}

export const DEFAULT_RETRY_BUDGET = 2;

// One pass gets a handful of retries, not one per sample. A reload mid-sample
// is a race worth surviving; a machine losing the context on every sample is a
// broken environment, and retrying through it turns a fast failure into a slow
// one while starving whatever else is running.
export function createRetryBudget(max = DEFAULT_RETRY_BUDGET): RetryBudget {
  return { remaining: max };
}

// One retry per call, not a loop: losing the context twice for the same sample
// is a real failure.
export async function withContextRetry<T>(
  enter: () => Promise<void>,
  body: () => Promise<T>,
  options?: { onRetry?: (warning: string) => void; budget?: RetryBudget },
): Promise<T> {
  try {
    return await body();
  } catch (err) {
    if (!isContextLostError(err)) throw err;
    const budget = options?.budget;
    if (budget) {
      if (budget.remaining <= 0) {
        const original = err instanceof Error ? err : new Error(String(err));
        throw new Error(original.message + RETRY_BUDGET_EXHAUSTED_NOTE, { cause: err });
      }
      budget.remaining--;
    }
    options?.onRetry?.(CONTEXT_RETRY_WARNING);
    await enter();
    return await body();
  }
}

// One browser per pass, matching every other measurement entry point. `enter`
// re-navigates within the same page and re-runs the preamble.
export async function runHarnessSession<T>(
  harness: HarnessResult,
  options: HarnessSessionOptions,
  body: (
    page: Page,
    cdp: CDPSession,
    enter: (search?: string) => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  const ms = await openMeasurementSession({
    driven: options.pacing !== "vsync",
    onWarning: options.onWarning,
    pool: options.pool,
  });
  try {
    const enter = (search?: string) =>
      enterHarness(ms.page, ms.session.cdp, harness, ms.errorCapture, {
        ...options,
        search: search ?? options.search,
      });
    await enter();
    return await body(ms.page, ms.session.cdp, enter);
  } finally {
    await ms.close();
  }
}

export interface WrapperOverhead {
  overheadMs: number;
  domNodes: number;
  // M41: read from the page rather than parsed from the wrapper source — the
  // control API knows whether the export was actually a callable setup.
  hasSetup: boolean;
}

const WRAPPER_OVERHEAD_WARMUP = 2;

export async function measureWrapperOverhead(
  page: Page,
  cdp: CDPSession,
  samples: number,
): Promise<WrapperOverhead> {
  const mountWrapper = async () => {
    await page.evaluate(() => (window as any).__120fps.mountWrapperOnly());
    await rafFence(page);
  };
  const unmount = () => page.evaluate(() => (window as any).__120fps.unmount());
  const countNodes = () => countComponentNodes(page);

  for (let w = 0; w < WRAPPER_OVERHEAD_WARMUP; w++) {
    await mountWrapper();
    await unmount();
  }

  const durations: number[] = [];
  let wrapperNodes = 0;
  let emptyNodes = 0;

  for (let s = 0; s < samples; s++) {
    await tryCollectGarbage(cdp);
    const events = await collectTrace(cdp, mountWrapper);
    durations.push(parseTraceDuration(events).totalDuration);
    if (s === 0) wrapperNodes = await countNodes();
    await unmount();
    if (s === 0) emptyNodes = await countNodes();
  }

  return {
    overheadMs: computeMedian(durations),
    domNodes: Math.max(0, wrapperNodes - emptyNodes),
    hasSetup: await page.evaluate(() => (window as any).__120fps?.hasSetup === true),
  };
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

const TRACE_TIMEOUT_MS = 60_000;

export function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

// Type-7 quantile (the default of R and numpy), so the printed number
// reproduces in any standard tool. Below n≈20 it is dominated by the slowest
// sample and estimates no tail — see the glossary.
export function computeP95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const h = (sorted.length - 1) * 0.95;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

// A combo measured straight after a different combo pays that combo's cold
// start in its first sample. The first combo of a pass also absorbs the
// process-level JIT warmup; every later one needs a single render. 0 stays 0:
// an explicit opt-out is honoured.
export function warmupsForPosition(position: number, warmupRuns: number): number {
  return position === 0 ? warmupRuns : Math.min(1, warmupRuns);
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

  let failed = false;
  try {
    await cdp.send("Tracing.start", {
      categories: "devtools.timeline,v8.execute",
      options: "sampling-frequency=10000",
    } as any);

    try {
      await action();
    } finally {
      await cdp.send("Tracing.end");
    }
    await traceComplete;
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    cdp.off("Tracing.dataCollected", onData);
    // A trace that never completed leaves the session started, and the next
    // Tracing.start then fails with "already been started" — turning one lost
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

async function traceMount(
  page: Page,
  cdp: CDPSession,
  props: PropCombination,
): Promise<TraceEvent[]> {
  await page.evaluate(() => (window as any).__120fps.unmount());

  const safeProps = serializeProps(props);
  return collectTrace(cdp, async () => {
    await page.evaluate(
      ([p, marker]: [any, string]) => {
        for (const k of Object.keys(p)) {
          if (p[k] === marker) p[k] = () => {};
        }
        (window as any).__120fps.mount(p);
      },
      [safeProps, FUNCTION_MARKER] as [Record<string, unknown>, string],
    );
    await rafFence(page);
  });
}

// Mount cost alone, with teardown outside the traced window.
export async function mountAndTrace(
  page: Page,
  cdp: CDPSession,
  props: PropCombination,
): Promise<number> {
  return parseTraceDuration(await traceMount(page, cdp, props)).totalDuration;
}

// domNodeCount/hasAnimation/measuredState are read only when collectDomInfo is
// set: their values are per-combo facts, and reading them per sample paid a
// getComputedStyle sweep under the CPU throttle on every sample (M34). Every
// probe runs between traced windows, never inside one.
export async function runMountUnmount(
  page: Page,
  cdp: CDPSession,
  props: PropCombination,
  collectDomInfo: boolean,
): Promise<{
  mountDur: number;
  unmountDur: number;
  domNodeCount: number;
  hasAnimation: boolean;
  measuredState: MeasuredState;
  mountEvents: TraceEvent[];
}> {
  const netBefore = collectDomInfo ? await readNetworkProbe(page) : undefined;

  const mountEvents = await traceMount(page, cdp, props);

  // The watch is armed first: `countComponentNodes` and `detectAnimations` cost
  // real time under the throttle, and content arriving while they run belongs
  // to the component, not to a gap in our instrumentation.
  if (collectDomInfo) await beginMutationWatch(page);

  const domNodeCount = collectDomInfo ? await countComponentNodes(page) : 0;

  const hasAnimation = collectDomInfo ? await detectAnimations(page) : false;

  let measuredState: MeasuredState = "settled";
  if (collectDomInfo) {
    const mutated = await endMutationWatch(page, MEASURED_STATE_HOLD_MS);
    const netAfter = await readNetworkProbe(page);
    measuredState = classifyMeasuredState({
      pendingNetwork: netAfter.pending.some((id) => id > (netBefore?.started ?? 0)),
      mutated,
      hasAnimation,
    });
  }

  const mountParsed = parseTraceDuration(mountEvents);

  const unmountEvents = await collectTrace(cdp, async () => {
    await page.evaluate(() => (window as any).__120fps.unmount());
    await rafFence(page);
  });

  const unmountParsed = parseTraceDuration(unmountEvents);

  return {
    mountDur: mountParsed.totalDuration,
    unmountDur: unmountParsed.totalDuration,
    domNodeCount,
    hasAnimation,
    measuredState,
    mountEvents,
  };
}

export interface RerenderResult {
  comboIndex: number;
  props: PropCombination;
  stable: TimingResult;
  change?: TimingResult;
  changeToProps?: PropCombination;
  // M35: which frame pacing produced this combo's numbers.
  pacing?: MeasurementPacing;
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

export async function mountAndWait(page: Page, props: PropCombination): Promise<void> {
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
  await rafFence(page);
}

export async function rerenderAndTrace(
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
    await rafFence(page);
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

  const animated = new Set(options.animatedComboIndices ?? []);
  const drivenIndices: number[] = [];
  const vsyncIndices: number[] = [];
  combos.forEach((_, i) => (animated.has(i) ? vsyncIndices : drivenIndices).push(i));

  const results: RerenderResult[] = new Array(combos.length);

  const runPass = async (ms: MeasurementSession, indices: number[]) => {
    const enter = async () => {
      await refreshCdpSession(ms.page, ms.session);
      await enterHarness(ms.page, ms.session.cdp, harness, ms.errorCapture, {
        label: "rerender harness",
        cpuThrottle,
      });
    };
    await enter();
    const retryBudget = createRetryBudget();

    for (const [position, ci] of indices.entries()) {
      const props = combos[ci];

      // Warmup on this combo's own props (results discarded, never recorded).
      const warmups = warmupsForPosition(position, warmupRuns);
      if (warmups > 0) {
        await mountAndWait(ms.page, props);
        for (let w = 0; w < warmups; w++) {
          await rerenderAndTrace(ms.page, ms.session.cdp, props);
        }
      }

      // Stable rerender: mount with props, then rerender with same props N times
      const stableSamples: number[] = [];
      for (let s = 0; s < sampleCount; s++) {
        stableSamples.push(
          await withContextRetry(
            enter,
            async () => {
              await suspendThrottle(ms.session.cdp, cpuThrottle, () => tryCollectGarbage(ms.session.cdp));
              await mountAndWait(ms.page, props);
              return rerenderAndTrace(ms.page, ms.session.cdp, props);
            },
            { onRetry: options.onWarning, budget: retryBudget },
          ),
        );
      }

      const result: RerenderResult = {
        comboIndex: ci,
        props,
        stable: buildTimingResult(stableSamples),
        pacing: ms.pacing,
      };

      // Prop-change rerender: mount with current props, rerender with next combo's props.
      // The pairing follows the full combo list, so partitioning by pacing
      // cannot change which combo rerenders into which.
      // Skip when either combo is a scale combo — cross-scale rerenders are not meaningful
      if (combos.length > 1) {
        const nextProps = combos[(ci + 1) % combos.length];
        const isScale = "__120fps_scaleN" in props;
        const nextIsScale = "__120fps_scaleN" in nextProps;
        if (!isScale && !nextIsScale) {
          const changeSamples: number[] = [];
          for (let s = 0; s < sampleCount; s++) {
            changeSamples.push(
              await withContextRetry(
                enter,
                async () => {
                  await suspendThrottle(ms.session.cdp, cpuThrottle, () => tryCollectGarbage(ms.session.cdp));
                  await mountAndWait(ms.page, props);
                  return rerenderAndTrace(ms.page, ms.session.cdp, nextProps);
                },
                { onRetry: options.onWarning, budget: retryBudget },
              ),
            );
          }
          result.change = buildTimingResult(changeSamples);
          result.changeToProps = nextProps;
        }
      }

      results[ci] = result;
    }
  };

  if (drivenIndices.length > 0) {
    const ms = await openMeasurementSession({ driven: true, onWarning: options.onWarning, pool: options.pool });
    try {
      await runPass(ms, drivenIndices);
    } finally {
      await ms.close();
    }
  }
  if (vsyncIndices.length > 0) {
    const ms = await openMeasurementSession({ driven: false, onWarning: options.onWarning, pool: options.pool });
    try {
      await runPass(ms, vsyncIndices);
    } finally {
      await ms.close();
    }
  }

  return results;
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

  const results: MountResult[] = new Array(combos.length);
  // Combos whose first sample detects a running animation: animation cost is
  // time-based, so driven frames change how much of it lands inside the traced
  // window. They are re-measured entirely under vsync pacing.
  const vsyncQueue: number[] = [];

  const runPass = async (
    ms: MeasurementSession,
    indices: number[],
    bailOnAnimation: boolean,
  ) => {
    const enter = async () => {
      await refreshCdpSession(ms.page, ms.session);
      await enterHarness(ms.page, ms.session.cdp, harness, ms.errorCapture, {
        label: "mount harness",
        cpuThrottle,
      });
    };
    await enter();
    const retryBudget = createRetryBudget();

    for (const [position, ci] of indices.entries()) {
      const props = combos[ci];

      // Warmup: JIT + module cache stabilization, on this combo's own props
      // (results discarded, never recorded).
      for (let w = 0; w < warmupsForPosition(position, warmupRuns); w++) {
        await runMountUnmount(ms.page, ms.session.cdp, props, false);
      }

      const mountSamples: number[] = [];
      const unmountSamples: number[] = [];
      const mountTraces: TraceEvent[][] = [];
      let domNodeCount = 0;
      let hasAnimation = false;
      let measuredState: MeasuredState = "settled";
      let bailed = false;

      let heapBefore = 0;
      try {
        const pre = await ms.session.cdp.send("Runtime.getHeapUsage" as any) as { usedSize: number };
        heapBefore = pre.usedSize;
      } catch { /* CDP method may not be available */ }

      for (let s = 0; s < sampleCount; s++) {
        const run = await withContextRetry(
          enter,
          async () => {
            await suspendThrottle(ms.session.cdp, cpuThrottle, () => tryCollectGarbage(ms.session.cdp));
            return runMountUnmount(ms.page, ms.session.cdp, props, s === 0);
          },
          { onRetry: options.onWarning, budget: retryBudget },
        );
        if (s === 0 && bailOnAnimation && run.hasAnimation) {
          vsyncQueue.push(ci);
          bailed = true;
          break;
        }
        mountSamples.push(run.mountDur);
        unmountSamples.push(run.unmountDur);
        mountTraces.push(run.mountEvents);
        if (s === 0) {
          domNodeCount = run.domNodeCount;
          hasAnimation = run.hasAnimation;
          measuredState = run.measuredState;
        }
      }
      if (bailed) continue;

      let heapDelta = 0;
      try {
        const post = await ms.session.cdp.send("Runtime.getHeapUsage" as any) as { usedSize: number };
        heapDelta = post.usedSize - heapBefore;
      } catch { /* fall back to 0 */ }

      results[ci] = {
        comboIndex: ci,
        props,
        mount: buildTimingResult(mountSamples),
        unmount: buildTimingResult(unmountSamples),
        domNodeCount,
        heapDelta,
        hasAnimation,
        measuredState,
        mountTraces,
        pacing: ms.pacing,
      };
    }
  };

  const driven = await openMeasurementSession({ driven: true, onWarning: options.onWarning, pool: options.pool });
  try {
    await runPass(
      driven,
      combos.map((_, i) => i),
      // A probe fallback already runs the whole pass under vsync — nothing to
      // bail to in that case.
      driven.pacing === "driven",
    );
  } finally {
    await driven.close();
  }

  if (vsyncQueue.length > 0) {
    const vs = await openMeasurementSession({ driven: false, onWarning: options.onWarning, pool: options.pool });
    try {
      await runPass(vs, vsyncQueue, false);
    } finally {
      await vs.close();
    }
  }

  return results;
}
