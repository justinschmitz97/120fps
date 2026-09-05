import path from "node:path";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import { hasAnyEnvFile, NO_ENV_FILE_REMEDY_NOTE, type HarnessResult } from "../harness/index.js";
import {
  attachPageErrorCapture,
  enrichPhaseError,
  gotoWithErrorContext,
  harnessReadyBoundNotice,
  harnessReadyTimeoutMs,
  waitForReadyOrFatal,
  type MeasurementPhase,
  type PageErrorCapture,
} from "./page-errors.js";
import { installMeasuredStateProbe } from "./dom.js";
import { reportFontSettle, settleStyles } from "./settle.js";
import { applyWrapperViewport } from "./measure.js";
import {
  createFramePump,
  FRAME_PUMP_WARNING,
  MEASUREMENT_BROWSER_ARGS,
  type BrowserPool,
  type MeasurementPacing,
} from "./pacing.js";

// Returns whether the CDP call succeeded; best-effort cleanup callers ignore it.
export async function tryCollectGarbage(cdp: CDPSession): Promise<boolean> {
  try {
    await cdp.send("HeapProfiler.collectGarbage" as any);
    return true;
  } catch {
    return false;
  }
}

// Errors propagate: `withContextRetry` re-entry re-engages the throttle, so no unknown state.
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

// A stylesheet whose webfont never answers keeps `load` pending past the settle gate's bound.
export const HARNESS_NAV_WAIT = "domcontentloaded" as const;

export interface HarnessSessionOptions {
  // Names the session in a readiness-timeout error.
  label: string;
  cpuThrottle?: number;
  // Appended to the harness URL, e.g. "?strict=1".
  search?: string;
  // "vsync" opts a pass out of begin-frame control (animated combos).
  pacing?: "driven" | "vsync";
  // Reuse pooled browsers (fresh context per session).
  pool?: BrowserPool;
  onWarning?: (warning: string) => void;
}

// Re-runnable, so a pass that navigates mid-session repeats the whole preamble.
export async function enterHarness(
  page: Page,
  cdp: CDPSession,
  harness: HarnessResult,
  errorCapture: PageErrorCapture,
  options: HarnessSessionOptions,
): Promise<void> {
  const url = harness.url + (options.search ?? "");
  // Disclosed before the wait it governs, so a mistyped bound is read with the timeout it caused.
  const boundNotice = harnessReadyBoundNotice();
  if (boundNotice) options.onWarning?.(boundNotice);
  await gotoWithErrorContext(page, url, errorCapture, options.label, {
    waitUntil: HARNESS_NAV_WAIT,
  });
  // A fatal module-evaluation throw wins the race, so the page error leads over the timeout.
  await waitForReadyOrFatal(
    () =>
      page.waitForFunction(
        () => typeof (window as any).__120fps === "object",
        undefined,
        { timeout: harnessReadyTimeoutMs() },
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

// Boxed so `enter` can swap the session; a captured const would keep using the wedged one.
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

// Best-effort: a completed measurement must not fail because teardown threw.
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

// One probe frame first: an undrivable compositor would otherwise hang on the first fence.
export async function openMeasurementSession(options: {
  driven: boolean;
  onWarning?: (warning: string) => void;
  pool?: BrowserPool;
  // Lets attachPageErrorCapture drop 404s under the harness root: placeholder collisions.
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

// `enter` re-navigates within the same page and re-runs the preamble.
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
// `run` is the only way a phase body reaches the caller, so no escape route stays unenriched.
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
