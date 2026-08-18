import { describe, it, expect } from "vitest";
import {
  resolveStressPattern,
  countPatternEvents,
  SCROLL_SWEEP_STEPS,
} from "../../src/stress-patterns.js";
import type { InteractionDescriptor } from "../../src/discovery.js";

function descriptor(overrides: Partial<InteractionDescriptor> = {}): InteractionDescriptor {
  return {
    type: "scroll",
    selector: "[data-testid=\"scrollport\"]",
    tagName: "DIV",
    label: "rows",
    scrollAxis: "vertical",
    ...overrides,
  };
}

// C1: dispatch.
describe("scroll-sweep dispatch", () => {
  it("wins over every other pattern for a scroll descriptor", () => {
    expect(resolveStressPattern(descriptor()).name).toBe("scroll-sweep");
  });

  it("wins even when the element also looks like a drag target", () => {
    const pattern = resolveStressPattern(descriptor({ cursor: "grab", ariaValueNow: true }));
    expect(pattern.name).toBe("scroll-sweep");
  });

  it("does not claim a descriptor that is not a scroll type", () => {
    expect(resolveStressPattern(descriptor({ type: "click" })).name).toBe("rapid-toggle-11");
  });

  it("carries the axis through to the step", () => {
    const pattern = resolveStressPattern(descriptor({ scrollAxis: "horizontal" }));
    expect(pattern.steps[0].direction).toBe("horizontal");
  });

  it("defaults to vertical when the axis is missing", () => {
    const pattern = resolveStressPattern(descriptor({ scrollAxis: undefined }));
    expect(pattern.steps[0].direction).toBe("vertical");
  });
});

// C2: the sweep is a round trip, and each wheel tick is one budgeted event.
describe("sweep shape and budget", () => {
  it("runs the same number of ticks in each direction", () => {
    const pattern = resolveStressPattern(descriptor());
    expect(pattern.steps[0].moveCount).toBe(SCROLL_SWEEP_STEPS * 2);
  });

  it("counts every wheel tick as an event, not the step", () => {
    expect(countPatternEvents(resolveStressPattern(descriptor()))).toBe(SCROLL_SWEEP_STEPS * 2);
  });

  it("uses one step so the executor can size the delta at run time", () => {
    expect(resolveStressPattern(descriptor()).steps).toHaveLength(1);
  });
});

// C3: scroll offset is not application state.
describe("state invariance", () => {
  it("marks the sweep state-invariant", () => {
    expect(resolveStressPattern(descriptor()).stateInvariant).toBe(true);
  });

  it("leaves every other pattern state-defining", () => {
    for (const type of ["click", "type", "hover", "focus"] as const) {
      expect(resolveStressPattern(descriptor({ type, scrollAxis: undefined })).stateInvariant)
        .toBeUndefined();
    }
  });
});
