import { chromium, type Browser } from "playwright";

// Headless Chromium pins rAF to 60 Hz; a driven fence costs ~2 ms instead of two vsync ticks.
export const MEASUREMENT_BROWSER_ARGS = [
  "--enable-begin-frame-control",
  // Without this flag HeadlessExperimental.beginFrame is rejected; each driven frame then paints.
  "--run-all-compositor-stages-before-draw",
];

export const FRAME_PUMP_WARNING =
  "begin-frame control unavailable; measurement ran under vsync pacing (slower, semantics unchanged)";

// Structural subset of CDPSession so the pump is testable without a browser.
interface FramePumpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface FramePump {
  stop(): Promise<void>;
  readonly disabled: boolean;
}

// Generous: navigations fail beginFrame transiently, and a dead pump is caught by the rAF fence.
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
        // Read per frame so the pump follows refreshCdpSession onto a replacement session.
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

// A new context gives a phase its own renderer with cold V8, so one browser per pacing suffices.
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
