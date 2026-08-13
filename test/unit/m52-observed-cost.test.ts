import { describe, it, expect } from "vitest";
import { observedInteractionMs, type ObservedWindow, type ObservedEvent } from "../../src/observers.js";

function evt(partial: Partial<ObservedEvent>): ObservedEvent {
  return {
    name: "click",
    interactionId: 0,
    durationMs: 0,
    delayMs: 0,
    processingMs: 0,
    ...partial,
  };
}

function win(partial: Partial<ObservedWindow>): ObservedWindow {
  return {
    events: [],
    longFrames: [],
    layoutShiftScore: 0,
    windowMs: 100,
    eventTimingUnavailable: false,
    ...partial,
  };
}

describe("m52 observed interaction cost", () => {
  it("counts one user interaction once, at its slowest entry", () => {
    // Chromium reports pointerdown/pointerup/click for a single click, sharing
    // an interactionId and ending at the same presentation.
    const window = win({
      events: [
        evt({ name: "pointerdown", interactionId: 7, durationMs: 24 }),
        evt({ name: "pointerup", interactionId: 7, durationMs: 40 }),
        evt({ name: "click", interactionId: 7, durationMs: 40 }),
      ],
    });
    expect(observedInteractionMs(window)).toBe(40);
  });

  it("does not accumulate the per-ancestor entries of one dispatch", () => {
    // pointerenter fires on every ancestor and each dispatch target produces its
    // own entry for the same frame. Measured: 62 entries for 11 clicks, which
    // summed to 2720ms against 1.8s of wall clock.
    const window = win({
      events: [
        evt({ name: "pointerover", durationMs: 80 }),
        evt({ name: "pointerenter", durationMs: 80 }),
        evt({ name: "pointerenter", durationMs: 80 }),
        evt({ name: "pointerenter", durationMs: 80 }),
      ],
    });
    expect(observedInteractionMs(window)).toBe(80);
  });

  it("reports the slowest interaction of a multi-step window, not their total", () => {
    // A window covers a whole stress pattern, but Event Timing cannot separate
    // per-step cost from overlapping entries, so the number is a maximum and
    // callers must not divide it by the step count.
    const window = win({
      events: [
        evt({ interactionId: 1, durationMs: 32 }),
        evt({ interactionId: 2, durationMs: 24 }),
        evt({ interactionId: 3, durationMs: 48 }),
      ],
    });
    expect(observedInteractionMs(window)).toBe(48);
  });

  it("falls back to long-frame blocking time when no event was observable", () => {
    // Every event sat under the 16ms floor; the frame that blocked is then the
    // only thing left to report.
    const window = win({
      events: [],
      longFrames: [
        { durationMs: 120, blockingMs: 70, scripts: [] },
        { durationMs: 80, blockingMs: 30, scripts: [] },
      ],
    });
    expect(observedInteractionMs(window)).toBe(70);
  });

  it("reads a quiet window as zero", () => {
    expect(observedInteractionMs(win({}))).toBe(0);
  });

  it("prefers the observed event over the frame that served it", () => {
    const window = win({
      events: [evt({ interactionId: 4, durationMs: 60 })],
      longFrames: [{ durationMs: 90, blockingMs: 45, scripts: [] }],
    });
    expect(observedInteractionMs(window)).toBe(60);
  });
});
