import { describe, it, expect } from "vitest";
import { resolveStressPattern, type StressPattern } from "../../src/stress-patterns.js";
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

// --- Pattern dispatch ---

describe("resolveStressPattern dispatch", () => {
  it("tab role + siblings → keyboard-sweep", () => {
    const desc = makeDescriptor({ type: "click", role: "tab" });
    const pattern = resolveStressPattern(desc, ["[role=tab]:nth-of-type(1)", "[role=tab]:nth-of-type(2)"]);
    expect(pattern.name).toBe("keyboard-sweep");
  });

  it("listbox role + siblings → keyboard-sweep", () => {
    const desc = makeDescriptor({ type: "select", role: "listbox" });
    const pattern = resolveStressPattern(desc, ["[role=option]:nth-of-type(1)"]);
    expect(pattern.name).toBe("keyboard-sweep");
  });

  it("combobox role + siblings → keyboard-sweep", () => {
    const desc = makeDescriptor({ type: "type", role: "combobox" });
    const pattern = resolveStressPattern(desc, ["[role=option]:nth-of-type(1)"]);
    expect(pattern.name).toBe("keyboard-sweep");
  });

  it("menu role + siblings → keyboard-sweep", () => {
    const desc = makeDescriptor({ type: "click", role: "menu" });
    const pattern = resolveStressPattern(desc, ["[role=menuitem]:nth-of-type(1)"]);
    expect(pattern.name).toBe("keyboard-sweep");
  });

  it("tree role + siblings → keyboard-sweep", () => {
    const desc = makeDescriptor({ type: "click", role: "tree" });
    const pattern = resolveStressPattern(desc, ["[role=treeitem]:nth-of-type(1)"]);
    expect(pattern.name).toBe("keyboard-sweep");
  });

  it("hover type + siblings → hover-sweep", () => {
    const desc = makeDescriptor({ type: "hover" });
    const pattern = resolveStressPattern(desc, ["li:nth-of-type(1)", "li:nth-of-type(2)", "li:nth-of-type(3)"]);
    expect(pattern.name).toBe("hover-sweep");
  });

  it("portal trigger (triggeredBy set) → open-close-10", () => {
    const desc = makeDescriptor({ type: "click", triggeredBy: "#trigger-btn" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("open-close-10");
  });

  it("dialog role → open-close-10", () => {
    const desc = makeDescriptor({ type: "click", role: "dialog" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("open-close-10");
  });

  it("type=type → multi-keystroke", () => {
    const desc = makeDescriptor({ type: "type", tagName: "INPUT" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("multi-keystroke");
  });

  it("type=click → rapid-toggle-10", () => {
    const desc = makeDescriptor({ type: "click" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("rapid-toggle-10");
  });

  it("type=focus → single-shot fallback", () => {
    const desc = makeDescriptor({ type: "focus" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("single-shot");
  });

  it("type=select → single-shot fallback", () => {
    const desc = makeDescriptor({ type: "select" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("single-shot");
  });

  it("type=keyboard → single-shot fallback", () => {
    const desc = makeDescriptor({ type: "keyboard" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("single-shot");
  });
});

// --- Dispatch priority ---

describe("resolveStressPattern priority", () => {
  it("role takes priority over type for tab+click", () => {
    const desc = makeDescriptor({ type: "click", role: "tab" });
    const pattern = resolveStressPattern(desc, ["[role=tab]:nth-of-type(1)"]);
    expect(pattern.name).toBe("keyboard-sweep");
  });

  it("tab role without siblings falls through to rapid-toggle-10 (click type)", () => {
    const desc = makeDescriptor({ type: "click", role: "tab" });
    const pattern = resolveStressPattern(desc, []);
    expect(pattern.name).toBe("rapid-toggle-10");
  });

  it("tab role without siblings arg falls through to rapid-toggle-10", () => {
    const desc = makeDescriptor({ type: "click", role: "tab" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("rapid-toggle-10");
  });

  it("hover without siblings falls through to single-shot", () => {
    const desc = makeDescriptor({ type: "hover" });
    const pattern = resolveStressPattern(desc, []);
    expect(pattern.name).toBe("single-shot");
  });

  it("portal trigger takes priority over type=type", () => {
    const desc = makeDescriptor({ type: "type", triggeredBy: "#trigger" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("open-close-10");
  });
});

// --- Step structure ---

describe("keyboard-sweep steps", () => {
  it("includes focus, ArrowDown × siblingCount, Home, End", () => {
    const desc = makeDescriptor({ type: "click", role: "tab", selector: "[role=tab]:nth-of-type(1)" });
    const siblings = ["[role=tab]:nth-of-type(1)", "[role=tab]:nth-of-type(2)", "[role=tab]:nth-of-type(3)"];
    const pattern = resolveStressPattern(desc, siblings);

    expect(pattern.steps[0]).toEqual({ action: "focus", selector: "[role=tab]:nth-of-type(1)" });

    const arrowDownSteps = pattern.steps.filter(
      (s) => s.action === "keyboard" && s.key === "ArrowDown",
    );
    expect(arrowDownSteps).toHaveLength(3);

    const lastTwo = pattern.steps.slice(-2);
    expect(lastTwo[0]).toEqual({ action: "keyboard", selector: "[role=tab]:nth-of-type(1)", key: "Home" });
    expect(lastTwo[1]).toEqual({ action: "keyboard", selector: "[role=tab]:nth-of-type(1)", key: "End" });
  });
});

describe("hover-sweep steps", () => {
  it("has one hover step per sibling", () => {
    const desc = makeDescriptor({ type: "hover", selector: "li:nth-of-type(1)" });
    const siblings = ["li:nth-of-type(1)", "li:nth-of-type(2)", "li:nth-of-type(3)"];
    const pattern = resolveStressPattern(desc, siblings);

    expect(pattern.steps).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(pattern.steps[i]).toEqual({ action: "hover", selector: siblings[i] });
    }
  });
});

describe("open-close-10 steps", () => {
  it("has 20 click steps (10 open + 10 close)", () => {
    const desc = makeDescriptor({ type: "click", triggeredBy: "#trigger", selector: "#modal-btn" });
    const pattern = resolveStressPattern(desc);

    const clickSteps = pattern.steps.filter((s) => s.action === "click");
    expect(clickSteps).toHaveLength(20);
    for (const step of clickSteps) {
      expect(step.selector).toBe("#modal-btn");
    }
  });
});

describe("multi-keystroke steps", () => {
  it("starts with focus then types individual characters", () => {
    const desc = makeDescriptor({ type: "type", selector: "#input" });
    const pattern = resolveStressPattern(desc);

    expect(pattern.steps[0]).toEqual({ action: "focus", selector: "#input" });
    const typeSteps = pattern.steps.filter((s) => s.action === "type");
    expect(typeSteps.length).toBe(10);
    const typed = typeSteps.map((s) => s.text).join("");
    expect(typed).toBe("abcde12345");
  });
});

describe("rapid-toggle-10 steps", () => {
  it("has 10 click steps on same selector", () => {
    const desc = makeDescriptor({ type: "click", selector: "#toggle" });
    const pattern = resolveStressPattern(desc);

    expect(pattern.steps).toHaveLength(10);
    for (const step of pattern.steps) {
      expect(step).toEqual({ action: "click", selector: "#toggle" });
    }
  });
});

describe("single-shot steps", () => {
  it("has exactly 1 step matching the descriptor type", () => {
    const desc = makeDescriptor({ type: "focus", selector: "#el" });
    const pattern = resolveStressPattern(desc);

    expect(pattern.steps).toHaveLength(1);
    expect(pattern.steps[0].action).toBe("focus");
    expect(pattern.steps[0].selector).toBe("#el");
  });
});

// --- Purity ---

describe("resolveStressPattern purity", () => {
  it("same input produces same output", () => {
    const desc = makeDescriptor({ type: "click", role: "tab" });
    const siblings = ["[role=tab]:nth-of-type(1)"];
    const a = resolveStressPattern(desc, siblings);
    const b = resolveStressPattern(desc, siblings);
    expect(a).toEqual(b);
  });
});
