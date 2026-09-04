import type { Page } from "playwright";

// M52. Opt-in acquisition of what a browser can observe about an interaction
// from inside the page: Event Timing, Long Animation Frames, layout
// instability. It reports latency the trace path cannot see, and cannot report
// the per-step work the trace path exists to measure: Event Timing's floor is
// 16ms per event, an order of magnitude above the 0.5-1ms/step real components
// measure, so explore keeps timing with traces (`ExploreOptions.observerTiming`
// selects this path).

export interface ObservedEvent {
  name: string;
  // Chromium groups the entries of one user interaction (pointerdown,
  // pointerup, click) under a shared id. 0 means the entry belongs to no
  // interaction: a hover, say.
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
  // Set when the browser reported no Event Timing entries at all, so a reader
  // can tell "nothing was slow" from "nothing was observable".
  eventTimingUnavailable: boolean;
}

// Chromium only emits Event Timing entries above a duration threshold. 16ms is
// the documented minimum the API accepts; the harness asks for it explicitly
// rather than relying on the 104ms default, and the observed floor is verified
// by test rather than assumed.
export const EVENT_TIMING_THRESHOLD_MS = 16;

export const OBSERVER_STATE_KEY = "__120fpsObs";

// Installed once per page, before any interaction, so every window observes
// under identical instrumentation.
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
        // Shifts within 500ms of an input are the component's own reflow, which
        // is exactly what an interaction measurement should count.
        state.shifts.push({ startTime: entry.startTime, value: entry.value } as any);
      });
    },
    [OBSERVER_STATE_KEY, durationThreshold] as [string, number],
  );
}

// Marks the start of a measured window. Entries are filtered by time rather
// than cleared, so a late-arriving entry cannot be attributed to the next
// window and nothing observed is thrown away.
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

    // An observer callback for the last interaction is queued as a task after
    // its frame presented, so reading straight after the caller's fence drops
    // it. Yield until a turn passes with nothing new, bounded so a page that
    // keeps emitting cannot hold the read open.
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

// The slowest interaction in a measured window, presentation-inclusive:
// deliberately a maximum, not a total. Chromium emits one entry per dispatch
// target, so a window of 11 clicks arrives as 62 entries: the
// pointerdown/pointerup/click trio of each click plus one pointerenter per
// ancestor, all ending at the same presentation. Summing them read 2720ms for
// 1.8s of wall clock. A window's total interaction cost is therefore not
// recoverable from Event Timing, which is why explore does not time with this.
export function observedInteractionMs(window: ObservedWindow): number {
  const worstEvent = window.events.reduce((max, e) => Math.max(max, e.durationMs), 0);
  if (worstEvent > 0) return worstEvent;
  // Nothing cleared the Event Timing floor. Long frames are then the only
  // observable cost.
  return window.longFrames.reduce((max, f) => Math.max(max, f.blockingMs), 0);
}
