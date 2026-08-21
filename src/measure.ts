import path from "node:path";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import { hasAnyEnvFile, NO_ENV_FILE_REMEDY_NOTE, type HarnessResult } from "./harness.js";
import type { PropCombination } from "./prop-gen-values.js";
import { extractProps } from "./prop-gen.js";
import { generateCombinations } from "./prop-gen-values.js";
import {
  attachPageErrorCapture,
  enrichPhaseError,
  gotoWithErrorContext,
  hasPageErrors,
  mergeDrains,
  waitForReadyOrFatal,
  type MeasurementPhase,
  type PageErrorCapture,
  type PageErrorDrain,
} from "./page-errors.js";

// M64: animation is what the page is *doing*, never what its stylesheet
// declares. A Tailwind `transition-all` on an idle button declares a transition
// and animates nothing, and reading it as animation forced static toolbars into
// T3. Every real case: a CSS animation, a running transition, a WAAPI
// animation: produces an `Animation` object here; a declared-but-untriggered
// transition produces none.
//
// Exported as source rather than a closure so the rule is one definition and
// can be exercised against stub objects without a browser.
export const OBSERVED_ANIMATION_EXPRESSION = `(function () {
  var root = document.getElementById("root");
  if (!root) return false;
  var animations = document.getAnimations();
  for (var i = 0; i < animations.length; i++) {
    var animation = animations[i];
    var effect = animation.effect;
    var target = effect ? effect.target : null;
    // Pseudo-element targets are not nodes and cannot be located in the tree.
    if (!target || typeof target.nodeType !== "number") continue;
    if (!root.contains(target)) continue;
    // "idle" is a cancelled or never-started animation; "finished" still ran
    // during the mount that was measured.
    if (animation.playState === "idle") continue;
    return true;
  }
  return false;
})()`;

export async function detectAnimations(page: Page): Promise<boolean> {
  return page.evaluate<boolean>(OBSERVED_ANIMATION_EXPRESSION);
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

// Begin, hold, end: the composed form, for callers that have nothing to do in
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

// M74 (B10): document.fonts.ready resolves once every FontFace has *settled*
// (loaded or errored), not once every one has *loaded*: a 404'd or
// decode-failed @font-face still lets `ready` resolve, so the fallback-font
// metrics it produces need their own signal.
export const FONT_LOAD_FAILED_WARNING = (families: string[]): string =>
  `font-face failed to load: ${families.join(", ")}; the measured metrics reflect the fallback font.`;

export interface FontSettleResult {
  settled: boolean;
  failedFamilies: string[];
}

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
): Promise<FontSettleResult> {
  if (!needsStyleSettle(harness)) return { settled: true, failedFamilies: [] };
  return page.evaluate(async (timeoutMs: number) => {
    const fonts = (
      document as unknown as {
        fonts?: { ready?: Promise<unknown> } & Iterable<{ status?: string; family?: string }>;
      }
    ).fonts;
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
    // fonts.ready resolves once every face has settled, loaded or errored: a
    // 404'd or decode-failed @font-face still lets it resolve, so a fallback
    // font measurement needs its own signal instead of reading as success.
    const failedFamilies: string[] = [];
    if (fonts) {
      for (const face of fonts) {
        if (face.status === "error" && typeof face.family === "string") {
          failedFamilies.push(face.family);
        }
      }
    }
    return { settled, failedFamilies: [...new Set(failedFamilies)] };
  }, FONT_SETTLE_TIMEOUT_MS);
}

// One wording, one place it is spelled: every phase that calls settleStyles
// and wants its failure surfaced routes through here instead of inventing its
// own message.
export function reportFontSettle(
  result: FontSettleResult,
  onWarning?: (warning: string) => void,
): void {
  if (!result.settled) onWarning?.(FONT_SETTLE_WARNING);
  if (result.failedFamilies.length > 0) onWarning?.(FONT_LOAD_FAILED_WARNING(result.failedFamilies));
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
  await gotoWithErrorContext(page, url, errorCapture, options.label, {
    waitUntil: HARNESS_NAV_WAIT,
  });
  // M79 gap 3b: races readiness against a fatal page error (a synchronous
  // throw during module evaluation, e.g. a next.config.mjs env-validation
  // failure). When the fatal signal wins, this throws immediately instead of
  // waiting out the remaining timeout, and leads with the page error instead
  // of "did not become ready within timeout".
  await waitForReadyOrFatal(
    () =>
      page.waitForFunction(
        () => typeof (window as any).__120fps === "object",
        undefined,
        { timeout: HARNESS_READY_TIMEOUT_MS },
      ),
    errorCapture,
    options.label,
    () => {
      const projectRoot = path.dirname(harness.harnessDir);
      return hasAnyEnvFile(projectRoot) ? undefined : NO_ENV_FILE_REMEDY_NOTE;
    },
  );

  await applyWrapperViewport(page);
  // Before any mount, so every sample runs under the same instrumentation.
  await installMeasuredStateProbe(page);
  reportFontSettle(await settleStyles(page, harness), options.onWarning);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: options.cpuThrottle ?? 4 });
}

export const CONTEXT_RETRY_WARNING =
  "the dev server reloaded the page mid-measurement; the affected sample was retried once";

// Promoted to user-facing text (M56): the retry above absorbs one reload, but
// exhausting the shared budget means the pattern kept recurring across the
// run: that points at the environment, not the component under test.
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
// two vsync ticks. Frames still happen: driven, not scheduled: so samples
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

// M89: taxonomy's control — `button.tsx` dies in the delta pass with this
// exact message, and the fence had no retry at all: one 10s timeout and the
// whole pass threw, uncaught until the CLI's top-level handler. Matches
// `rafFence`'s own thrown text.
const FRAME_STARVATION_PATTERN = /frame starvation/i;

export function isFrameStarvationError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return FRAME_STARVATION_PATTERN.test(message);
}

// M89 defect 1 (live taxonomy proof): the same run that correctly degraded
// two starved combos then still died with `browserContext.newCDPSession:
// Target page, context or browser has been closed` -- a closed target is
// exactly as recoverable as a starved fence (both are fixed by replacing the
// CDP session via `enter`), but only frame starvation was guarded here.
// `Tracing.tracingComplete timed out` fails the same way (a wedged CDP
// trace pipeline, also fixed by `enter` replacing the session). Patterns
// mirror `STALL_SIGNATURES` in page-errors.ts and the two matching entries
// already in this file's own `CONTEXT_LOST` list above -- kept as separate
// literals rather than shared, since page-errors.ts's list also carries
// hint-selection concerns this module has no reason to depend on, and
// `CONTEXT_LOST` is a disjoint retry layer (`withContextRetry`) this one
// composes around, not merges into.
const TRACING_TIMEOUT_PATTERN = /Tracing\.tracingComplete timed out/i;
const TARGET_CLOSED_PATTERN = /Target (page|closed|crashed)/i;

export function isTracingTimeoutError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return TRACING_TIMEOUT_PATTERN.test(message);
}

export function isTargetClosedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return TARGET_CLOSED_PATTERN.test(message);
}

// The three signatures `withFrameStarvationRetry` recovers from, sharing one
// bounded budget (`MAX_FRAME_STARVATION_RETRIES`). No shutdown/abort signal
// is observable anywhere in this codebase (no SIGINT/SIGTERM handler and no
// AbortController threaded through measurement), so a target closed by a
// genuine process teardown cannot be distinguished, from here, from one
// closed by a transient crash. The small fixed budget is the safeguard
// either way: a real teardown costs at most two quick, already-failing
// attempts before this degrades the combo and returns, rather than hanging
// or looping.
type StallKind = "starvation" | "tracing-timeout" | "target-closed";

function classifyStall(err: unknown): StallKind | undefined {
  if (isFrameStarvationError(err)) return "starvation";
  if (isTracingTimeoutError(err)) return "tracing-timeout";
  if (isTargetClosedError(err)) return "target-closed";
  return undefined;
}

export const MAX_FRAME_STARVATION_RETRIES = 2;

export const frameStarvationRetryWarning = (comboIndex: number): string =>
  `combo ${comboIndex}: rAF fence starved for frames; retrying against a freshly re-entered harness session`;

export const frameStarvationDegradedWarning = (comboIndex: number): string =>
  `combo ${comboIndex}: measurement did not complete after ${MAX_FRAME_STARVATION_RETRIES} retries ` +
  `(frame starvation); omitted from the report rather than failing the run`;

export const tracingTimeoutRetryWarning = (comboIndex: number): string =>
  `combo ${comboIndex}: cost-attribution trace stalled (Tracing.tracingComplete timed out); ` +
  `retrying against a freshly re-entered harness session`;

export const tracingTimeoutDegradedWarning = (comboIndex: number): string =>
  `combo ${comboIndex}: measurement did not complete after ${MAX_FRAME_STARVATION_RETRIES} retries ` +
  `(tracing timeout); omitted from the report rather than failing the run`;

export const targetClosedRetryWarning = (comboIndex: number): string =>
  `combo ${comboIndex}: browser target closed mid-measurement; retrying against a freshly re-entered harness session`;

export const targetClosedDegradedWarning = (comboIndex: number): string =>
  `combo ${comboIndex}: measurement did not complete after ${MAX_FRAME_STARVATION_RETRIES} retries ` +
  `(target closed); omitted from the report rather than failing the run`;

function retryWarningFor(kind: StallKind, comboIndex: number): string {
  if (kind === "tracing-timeout") return tracingTimeoutRetryWarning(comboIndex);
  if (kind === "target-closed") return targetClosedRetryWarning(comboIndex);
  return frameStarvationRetryWarning(comboIndex);
}

function degradedWarningFor(kind: StallKind, comboIndex: number): string {
  if (kind === "tracing-timeout") return tracingTimeoutDegradedWarning(comboIndex);
  if (kind === "target-closed") return targetClosedDegradedWarning(comboIndex);
  return frameStarvationDegradedWarning(comboIndex);
}

// M89: a bounded, disclosed retry for failure signatures the fence itself
// (and, per defect 1, a closed target or a wedged trace pipeline) has no
// recovery from — orthogonal to `withContextRetry` (a disjoint signature
// list, its own escalate-and-throw behavior on exhaustion, unchanged by
// this). On exhaustion this does NOT throw: it discloses and returns
// `undefined`, so the caller can omit the one combo that stalled rather
// than failing every other combo in the same pass. `enter` is the same
// session-refresh (`refreshCdpSession` + `enterHarness`) the context-lost
// retry already uses — it replaces the CDP session the frame pump reads on
// every loop iteration, which is the most plausible recovery path for all
// three signatures alike.
export async function withFrameStarvationRetry<T>(
  comboIndex: number,
  enter: () => Promise<void>,
  body: () => Promise<T>,
  onWarning?: (warning: string) => void,
): Promise<T | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await body();
    } catch (err) {
      const kind = classifyStall(err);
      if (!kind) throw err;
      if (attempt >= MAX_FRAME_STARVATION_RETRIES) {
        onWarning?.(degradedWarningFor(kind, comboIndex));
        return undefined;
      }
      onWarning?.(retryWarningFor(kind, comboIndex));
      try {
        await enter();
      } catch (enterErr) {
        // M92 (1.5a, regression): enter() re-runs enterHarness's own
        // independent style-settle fence (measure.ts's settleStyles). Left
        // unguarded, a stall there escaped this function entirely -- the
        // exact failure this retry exists to prevent, relocated one frame
        // up. Counts against the same bounded budget as a body() stall
        // (this iteration already consumed one `attempt`) and falls through
        // to retry body() on the next iteration rather than throwing; that
        // retry's own stall, if any, degrades normally through the branch
        // above once the budget is exhausted.
        const enterKind = classifyStall(enterErr);
        if (!enterKind) throw enterErr;
        if (attempt >= MAX_FRAME_STARVATION_RETRIES) {
          onWarning?.(degradedWarningFor(enterKind, comboIndex));
          return undefined;
        }
        onWarning?.(retryWarningFor(enterKind, comboIndex));
      }
    }
  }
}

// M89 (2, live taxonomy proof continued): combo 2 correctly degraded via its
// sample loop's withFrameStarvationRetry composition; the very next combo
// then still failed the whole run with a raw, unwrapped `frame starvation`
// error -- and no preceding "retrying against a freshly re-entered harness
// session" warning at all, which withFrameStarvationRetry can never omit on
// a classified failure (it always warns before its first retry). That is
// proof the failure never reached withFrameStarvationRetry: the cause is not
// budget scoping (`withFrameStarvationRetry`'s own `attempt` counter is a
// fresh local on every call, already isolated per invocation), it is a
// coverage gap. `measureRerender`'s and `measureMount`'s warmup calls
// (`mountAndWait`, `rerenderAndTrace`, `runMountUnmount`) touch the same
// rafFence-guarded page as the sample loops but ran directly, outside any
// retry wrapper -- whichever combo happened to starve during its warmup
// (rather than during a sample) escaped retry/degrade entirely and took the
// whole pass down. `withWarmupRetry` closes that gap with the identical
// composition the sample loops already use (`withFrameStarvationRetry`
// around `withContextRetry`, sharing the pass's `retryBudget`), so a
// warmup-time stall degrades the combo exactly like a sample-time one
// instead of escaping unguarded.
export async function withWarmupRetry(
  comboIndex: number,
  enter: () => Promise<void>,
  warmup: () => Promise<void>,
  retryBudget: RetryBudget,
  onWarning?: (warning: string) => void,
): Promise<boolean> {
  const completed = await withFrameStarvationRetry(
    comboIndex,
    enter,
    async () => {
      await withContextRetry(enter, warmup, { onRetry: onWarning, budget: retryBudget });
      return true as const;
    },
    onWarning,
  );
  return completed === true;
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
// renderer process: V8 as cold as in a fresh browser). The pool holds at
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
// session's page goes away. Best-effort: a completed measurement must not fail
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
  // M83 #2: threaded into attachPageErrorCapture so a bare, extension-less
  // 404 landing directly under the harness's own serving root (a
  // synthesized-placeholder collision, not a component defect) is excluded
  // from attribution.
  harnessDirName?: string;
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
      const errorCapture = attachPageErrorCapture(page, options.harnessDirName);
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
  const errorCapture = attachPageErrorCapture(page, options.harnessDirName);
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
    harnessDirName: path.basename(harness.harnessDir),
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
  // M41: read from the page rather than parsed from the wrapper source: the
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

// M59: one phase's failure context, mutated as the pass advances. `run` is the
// only way a phase body reaches the caller, so no escape route is left
// unenriched.
export interface PhaseTracker {
  combo: number | undefined;
  run<T>(body: () => Promise<T>): Promise<T>;
}

export function createPhaseTracker(
  phase: MeasurementPhase,
  harness: Pick<HarnessResult, "componentPath">,
): PhaseTracker {
  const component = path.basename(harness.componentPath);
  const tracker: PhaseTracker = {
    combo: undefined,
    async run(body) {
      try {
        return await body();
      } catch (err) {
        throw enrichPhaseError(err, {
          phase,
          component,
          ...(tracker.combo !== undefined ? { comboIndex: tracker.combo } : {}),
        });
      }
    },
  };
  return tracker;
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
  // M59: everything the page threw or logged as an error while this combo was
  // measured. Absent when the page stayed quiet.
  pageErrors?: PageErrorDrain;
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
// sample and estimates no tail: see the glossary.
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
    // Tracing.start then fails with "already been started": turning one lost
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
  // M59: page errors raised while this combo's rerenders were measured.
  pageErrors?: PageErrorDrain;
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
  const inFlight = createPhaseTracker("rerender", harness);

  const runPass = async (ms: MeasurementSession, indices: number[]) => {
    const enter = async () => {
      await refreshCdpSession(ms.page, ms.session);
      await enterHarness(ms.page, ms.session.cdp, harness, ms.errorCapture, {
        label: "rerender harness",
        cpuThrottle,
        onWarning: options.onWarning,
      });
    };
    await enter();
    const retryBudget = createRetryBudget();

    for (const [position, ci] of indices.entries()) {
      inFlight.combo = ci;
      const props = combos[ci];

      // Warmup on this combo's own props (results discarded, never recorded).
      // M89 (2): guarded by withWarmupRetry the same way the sample loops
      // below are — a starvation during warmup previously escaped retry
      // entirely and failed the whole pass instead of omitting just this
      // combo. An exhausted warmup omits the combo (its slot in `results`
      // stays unset) rather than propagating.
      const warmups = warmupsForPosition(position, warmupRuns);
      if (warmups > 0) {
        const warmed = await withWarmupRetry(
          ci,
          enter,
          async () => {
            await mountAndWait(ms.page, props);
            for (let w = 0; w < warmups; w++) {
              await rerenderAndTrace(ms.page, ms.session.cdp, props);
            }
          },
          retryBudget,
          options.onWarning,
        );
        if (!warmed) {
          ms.errorCapture.drain();
          continue;
        }
      }

      // Stable rerender: mount with props, then rerender with same props N times.
      // M89: a frame-starvation failure retries (bounded) against a freshly
      // re-entered session; a sample that still starves after the bound is
      // omitted (not pushed), not thrown — the delta pass's extra rerender
      // calls are exactly where this fires (taxonomy's control).
      const stableSamples: number[] = [];
      for (let s = 0; s < sampleCount; s++) {
        const sample = await withFrameStarvationRetry(
          ci,
          enter,
          () =>
            withContextRetry(
              enter,
              async () => {
                await suspendThrottle(ms.session.cdp, cpuThrottle, () => tryCollectGarbage(ms.session.cdp));
                await mountAndWait(ms.page, props);
                return rerenderAndTrace(ms.page, ms.session.cdp, props);
              },
              { onRetry: options.onWarning, budget: retryBudget },
            ),
          options.onWarning,
        );
        if (sample !== undefined) stableSamples.push(sample);
      }

      // Every sample for this combo starved out even after retrying: the
      // combo is omitted entirely (a disclosed partial result — the pass
      // continues to the rest of the combos) rather than reporting a
      // misleading all-zero timing for a combo nothing was actually measured
      // on.
      if (stableSamples.length === 0) continue;

      const result: RerenderResult = {
        comboIndex: ci,
        props,
        stable: buildTimingResult(stableSamples),
        pacing: ms.pacing,
      };

      // Prop-change rerender: mount with current props, rerender with next combo's props.
      // The pairing follows the full combo list, so partitioning by pacing
      // cannot change which combo rerenders into which.
      // Skip when either combo is a scale combo: cross-scale rerenders are not meaningful
      if (combos.length > 1) {
        const nextProps = combos[(ci + 1) % combos.length];
        const isScale = "__120fps_scaleN" in props;
        const nextIsScale = "__120fps_scaleN" in nextProps;
        if (!isScale && !nextIsScale) {
          const changeSamples: number[] = [];
          for (let s = 0; s < sampleCount; s++) {
            const sample = await withFrameStarvationRetry(
              ci,
              enter,
              () =>
                withContextRetry(
                  enter,
                  async () => {
                    await suspendThrottle(ms.session.cdp, cpuThrottle, () => tryCollectGarbage(ms.session.cdp));
                    await mountAndWait(ms.page, props);
                    return rerenderAndTrace(ms.page, ms.session.cdp, nextProps);
                  },
                  { onRetry: options.onWarning, budget: retryBudget },
                ),
              options.onWarning,
            );
            if (sample !== undefined) changeSamples.push(sample);
          }
          if (changeSamples.length > 0) {
            result.change = buildTimingResult(changeSamples);
            result.changeToProps = nextProps;
          }
        }
      }

      const drained = ms.errorCapture.drain();
      if (hasPageErrors(drained)) result.pageErrors = drained;

      results[ci] = result;
    }
  };

  if (drivenIndices.length > 0) {
    const ms = await openMeasurementSession({ driven: true, onWarning: options.onWarning, pool: options.pool, harnessDirName: path.basename(harness.harnessDir) });
    try {
      await inFlight.run(() => runPass(ms, drivenIndices));
    } finally {
      await ms.close();
    }
  }
  if (vsyncIndices.length > 0) {
    const ms = await openMeasurementSession({ driven: false, onWarning: options.onWarning, pool: options.pool, harnessDirName: path.basename(harness.harnessDir) });
    try {
      await inFlight.run(() => runPass(ms, vsyncIndices));
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

  // M59: tracked rather than passed, so a failure in a pass preamble reports
  // the phase alone and one inside a combo reports the combo too.
  const inFlight = createPhaseTracker("mount", harness);
  // Errors seen by a combo's driven attempt before it bailed to the vsync
  // queue; merged into the result the re-measurement writes.
  const carriedErrors = new Map<number, PageErrorDrain | undefined>();

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
        onWarning: options.onWarning,
      });
    };
    await enter();
    const retryBudget = createRetryBudget();

    for (const [position, ci] of indices.entries()) {
      inFlight.combo = ci;
      const props = combos[ci];

      // Warmup: JIT + module cache stabilization, on this combo's own props
      // (results discarded, never recorded).
      // M89 (2): guarded by withWarmupRetry the same way the sample loop
      // below is — a starvation during warmup previously escaped retry
      // entirely and failed the whole pass instead of omitting just this
      // combo. An exhausted warmup omits the combo (its slot in `results`
      // stays unset) rather than propagating.
      const warmupCount = warmupsForPosition(position, warmupRuns);
      if (warmupCount > 0) {
        const warmed = await withWarmupRetry(
          ci,
          enter,
          async () => {
            for (let w = 0; w < warmupCount; w++) {
              await runMountUnmount(ms.page, ms.session.cdp, props, false);
            }
          },
          retryBudget,
          options.onWarning,
        );
        if (!warmed) {
          ms.errorCapture.drain();
          continue;
        }
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

      // M89: a frame-starvation failure retries (bounded) against a freshly
      // re-entered session; a sample that still starves after the bound is
      // skipped, not thrown — the delta pass's own extra mount calls are one
      // of the two places this fires.
      for (let s = 0; s < sampleCount; s++) {
        const run = await withFrameStarvationRetry(
          ci,
          enter,
          () =>
            withContextRetry(
              enter,
              async () => {
                await suspendThrottle(ms.session.cdp, cpuThrottle, () => tryCollectGarbage(ms.session.cdp));
                return runMountUnmount(ms.page, ms.session.cdp, props, s === 0);
              },
              { onRetry: options.onWarning, budget: retryBudget },
            ),
          options.onWarning,
        );
        if (run === undefined) continue;
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
      // M59: closes this combo's window over the page's error stream. A combo
      // that bails to the vsync queue keeps what the driven attempt saw, so the
      // re-measurement adds to it rather than replacing it.
      const drained = ms.errorCapture.drain();
      if (bailed) {
        carriedErrors.set(ci, mergeDrains(carriedErrors.get(ci), drained));
        continue;
      }
      // M89: every sample for this combo starved out even after retrying —
      // omitted entirely (a disclosed partial result), not reported as an
      // all-zero mount that nothing was actually measured on.
      if (mountSamples.length === 0) continue;
      const pageErrors = mergeDrains(carriedErrors.get(ci), drained);

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
        ...(hasPageErrors(pageErrors) ? { pageErrors: pageErrors! } : {}),
      };
    }
  };

  const driven = await openMeasurementSession({ driven: true, onWarning: options.onWarning, pool: options.pool, harnessDirName: path.basename(harness.harnessDir) });
  try {
    await inFlight.run(() =>
      runPass(
        driven,
        combos.map((_, i) => i),
        // A probe fallback already runs the whole pass under vsync: nothing to
        // bail to in that case.
        driven.pacing === "driven",
      ),
    );
  } finally {
    await driven.close();
  }

  if (vsyncQueue.length > 0) {
    const vs = await openMeasurementSession({ driven: false, onWarning: options.onWarning, pool: options.pool, harnessDirName: path.basename(harness.harnessDir) });
    try {
      await inFlight.run(() => runPass(vs, vsyncQueue, false));
    } finally {
      await vs.close();
    }
  }

  return results;
}
