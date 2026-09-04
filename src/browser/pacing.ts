import { chromium, type Browser } from "playwright";

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
