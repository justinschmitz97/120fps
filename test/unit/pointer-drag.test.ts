import { describe, it, expect } from "vitest";
import { resolveStressPattern } from "../../src/stress-patterns.js";
import type { InteractionDescriptor } from "../../src/discovery.js";

function makeDescriptor(
  overrides: Partial<InteractionDescriptor> = {},
): InteractionDescriptor {
  return {
    type: "click",
    selector: "button",
    tagName: "BUTTON",
    label: "Test",
    ...overrides,
  };
}

// --- Dispatch ---

describe("pointer-drag dispatch", () => {
  it("role=slider → pointer-drag", () => {
    const desc = makeDescriptor({ role: "slider" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("pointer-drag");
  });

  it("input[type=range] → pointer-drag", () => {
    const desc = makeDescriptor({ tagName: "INPUT", inputType: "range" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("pointer-drag");
  });

  it("aria-valuenow present → pointer-drag", () => {
    const desc = makeDescriptor({ ariaValueNow: true });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("pointer-drag");
  });

  it("cursor=grab → pointer-drag", () => {
    const desc = makeDescriptor({ cursor: "grab" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("pointer-drag");
  });

  it("cursor=col-resize → pointer-drag", () => {
    const desc = makeDescriptor({ cursor: "col-resize" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("pointer-drag");
  });

  it("cursor=row-resize → pointer-drag", () => {
    const desc = makeDescriptor({ cursor: "row-resize" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("pointer-drag");
  });

  it("non-drag element unchanged", () => {
    const desc = makeDescriptor({ type: "click" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("rapid-toggle-10");
  });
});

// --- Step structure ---

describe("pointer-drag step structure", () => {
  it("has exactly 1 step with action pointer-drag", () => {
    const desc = makeDescriptor({ role: "slider", selector: "#slider" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.steps).toHaveLength(1);
    expect(pattern.steps[0].action).toBe("pointer-drag");
    expect(pattern.steps[0].selector).toBe("#slider");
  });

  it("defaults to horizontal direction", () => {
    const desc = makeDescriptor({ role: "slider" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.steps[0].direction).toBe("horizontal");
  });

  it("aria-orientation=vertical → vertical direction", () => {
    const desc = makeDescriptor({ role: "slider", ariaOrientation: "vertical" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.steps[0].direction).toBe("vertical");
  });

  it("moveCount defaults to 60", () => {
    const desc = makeDescriptor({ role: "slider" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.steps[0].moveCount).toBe(60);
  });
});

// --- Priority ---

describe("pointer-drag priority", () => {
  it("slider role takes priority over keyboard-sweep (even with siblings)", () => {
    const desc = makeDescriptor({ role: "slider" });
    const pattern = resolveStressPattern(desc, ["#sibling1", "#sibling2"]);
    expect(pattern.name).toBe("pointer-drag");
  });

  it("range input takes priority over rapid-toggle-10", () => {
    const desc = makeDescriptor({ type: "click", tagName: "INPUT", inputType: "range" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("pointer-drag");
  });

  it("drag cursor takes priority over open-close-10", () => {
    const desc = makeDescriptor({ type: "click", cursor: "grab", triggeredBy: "#trigger" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("pointer-drag");
  });

  it("valuenow takes priority over multi-keystroke", () => {
    const desc = makeDescriptor({ type: "type", ariaValueNow: true });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("pointer-drag");
  });
});

// --- Purity ---

describe("pointer-drag purity", () => {
  it("same input produces same output", () => {
    const desc = makeDescriptor({ role: "slider" });
    const a = resolveStressPattern(desc);
    const b = resolveStressPattern(desc);
    expect(a).toEqual(b);
  });
});
