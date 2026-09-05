import type { Page } from "playwright";

export interface ObservedEvent {
  name: string;
  // Chromium shares one id across an interaction's entries; 0 means the entry belongs to none.
  interactionId: number;
  // Time from the input event to the first frame that showed its result.
  durationMs: number;
  // Input delay: queued-to-handled. The part the main thread was already busy.
  delayMs: number;
  processingMs: number;
}

export interface ObservedLongFrame {
  durationMs: number;
  blockingMs: number;
  // Script sources LoAF attributes the frame to, when it names any.
  scripts: string[];
}

export interface ObservedWindow {
  events: ObservedEvent[];
  longFrames: ObservedLongFrame[];
  layoutShiftScore: number;
  // Wall-clock span of the bracketed window, from the in-page clock.
  windowMs: number;
  // Distinguishes "nothing was slow" from "nothing was observable".
  eventTimingUnavailable: boolean;
}

// The documented minimum Event Timing accepts; its 104ms default would hide most entries.
export const EVENT_TIMING_THRESHOLD_MS = 16;

export const OBSERVER_STATE_KEY = "__120fpsObs";

// Install before any interaction, so every window observes under identical instrumentation.
export async function installObservers(
  page: Page,
  durationThreshold: number = EVENT_TIMING_THRESHOLD_MS,
): Promise<void> {
  await page.evaluate(
    ([key, threshold]: [string, number]) => {
      const w = window as any;
      if (w[key]) return;

      const state = {
        events: [] as any[],
        longFrames: [] as any[],
        shifts: [] as number[],
        eventTimingSupported: false,
        start: 0,
      };
      w[key] = state;

      const observe = (type: string, options: Record<string, unknown>, sink: (entry: any) => void) => {
        try {
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) sink(entry);
          });
          observer.observe({ type, buffered: true, ...options } as PerformanceObserverInit);
          return true;
        } catch {
          // An unsupported entry type must degrade to absence, never to a zero.
          return false;
        }
      };

      state.eventTimingSupported = observe("event", { durationThreshold: threshold }, (entry) => {
        state.events.push({
          name: entry.name,
          startTime: entry.startTime,
          interactionId: entry.interactionId ?? 0,
          durationMs: entry.duration,
          delayMs: Math.max(0, (entry.processingStart ?? entry.startTime) - entry.startTime),
          processingMs: Math.max(0, (entry.processingEnd ?? 0) - (entry.processingStart ?? 0)),
        });
      });

      observe("long-animation-frame", {}, (entry) => {
        state.longFrames.push({
          startTime: entry.startTime,
          durationMs: entry.duration,
          blockingMs: entry.blockingDuration ?? 0,
          scripts: (entry.scripts ?? [])
            .map((s: any) => s.sourceURL || s.invoker || "")
            .filter(Boolean),
        });
      });

      observe("layout-shift", {}, (entry) => {
        // Input-driven shifts are kept: the component's own reflow is what an interaction costs.
        state.shifts.push({ startTime: entry.startTime, value: entry.value } as any);
      });
    },
    [OBSERVER_STATE_KEY, durationThreshold] as [string, number],
  );
}

// Entries are filtered by time, never cleared, so a late entry cannot land in the next window.
export async function beginObservedWindow(page: Page): Promise<void> {
  await page.evaluate((key: string) => {
    const state = (window as any)[key];
    if (state) state.start = performance.now();
  }, OBSERVER_STATE_KEY);
}

export async function readObservedWindow(page: Page): Promise<ObservedWindow> {
  return page.evaluate(async (key: string) => {
    const state = (window as any)[key];
    const empty = {
      events: [],
      longFrames: [],
      layoutShiftScore: 0,
      windowMs: 0,
      eventTimingUnavailable: true,
    };
    if (!state) return empty;

    // The last callback is queued after its frame, so a read right after the fence drops it.
    const settled = async () => {
      for (let turn = 0; turn < 3; turn++) {
        const before = state.events.length + state.longFrames.length;
        await new Promise((r) => setTimeout(r, 0));
        if (state.events.length + state.longFrames.length === before) return;
      }
    };
    await settled();

    const now = performance.now();
    const since = state.start;
    const inWindow = (entry: any) => entry.startTime >= since;

    return {
      events: state.events.filter(inWindow).map((e: any) => ({
        name: e.name,
        interactionId: e.interactionId,
        durationMs: e.durationMs,
        delayMs: e.delayMs,
        processingMs: e.processingMs,
      })),
      longFrames: state.longFrames.filter(inWindow).map((f: any) => ({
        durationMs: f.durationMs,
        blockingMs: f.blockingMs,
        scripts: f.scripts,
      })),
      layoutShiftScore: state.shifts
        .filter(inWindow)
        .reduce((sum: number, s: any) => sum + s.value, 0),
      windowMs: now - since,
      eventTimingUnavailable: !state.eventTimingSupported,
    };
  }, OBSERVER_STATE_KEY);
}

// A maximum, never a total: Chromium emits one entry per dispatch target of one presentation.
export function observedInteractionMs(window: ObservedWindow): number {
  const worstEvent = window.events.reduce((max, e) => Math.max(max, e.durationMs), 0);
  if (worstEvent > 0) return worstEvent;
  // Nothing cleared the Event Timing floor; long frames are the only observable cost left.
  return window.longFrames.reduce((max, f) => Math.max(max, f.blockingMs), 0);
}
