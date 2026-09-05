import { describe, it, expect } from "vitest";
import { observedInteractionMs, type ObservedWindow, type ObservedEvent } from "../../src/browser/index.js";

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

describe("observed interaction cost", () => {
  it("counts one user interaction once, at its slowest entry", () => {
    // Chromium fires pointerdown/pointerup/click once; same interactionId, same presentation.
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
    // pointerenter fires per ancestor; 11 clicks measured 62 entries, 2720ms vs 1.8s wall clock.
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
    // Event Timing cannot separate per-step cost; report the max, don't divide by step count.
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
    // Every event sat under the 16ms floor; the blocking frame is the only signal left.
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
