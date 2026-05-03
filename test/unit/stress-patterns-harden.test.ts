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

describe("H1: aria-haspopup descriptor without triggeredBy or dialog role", () => {
  it("descriptor with portal:true and click type falls through to rapid-toggle-10 (portal flag alone is not a trigger signal)", () => {
    const desc = makeDescriptor({ type: "click", portal: true });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("rapid-toggle-10");
  });
});

describe("H2: accordion role falls through to type-based pattern", () => {
  it("accordion role + click type → rapid-toggle-10 (not keyboard-sweep)", () => {
    const desc = makeDescriptor({ type: "click", role: "accordion" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("rapid-toggle-10");
  });

  it("accordion role with siblings still not keyboard-sweep", () => {
    const desc = makeDescriptor({ type: "click", role: "accordion" });
    const pattern = resolveStressPattern(desc, ["button:nth-of-type(1)"]);
    expect(pattern.name).toBe("rapid-toggle-10");
  });
});

describe("H3: type=select with no role → single-shot", () => {
  it("resolves to single-shot", () => {
    const desc = makeDescriptor({ type: "select", tagName: "SELECT" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("single-shot");
  });
});

describe("H4: type=hover with no siblings and no role → single-shot", () => {
  it("empty siblings array → single-shot", () => {
    const desc = makeDescriptor({ type: "hover" });
    const pattern = resolveStressPattern(desc, []);
    expect(pattern.name).toBe("single-shot");
  });

  it("undefined siblings → single-shot", () => {
    const desc = makeDescriptor({ type: "hover" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("single-shot");
  });
});

describe("H5: keyboard-sweep with 1 sibling → 4 steps", () => {
  it("produces focus + 1 ArrowDown + Home + End", () => {
    const desc = makeDescriptor({ type: "click", role: "tab", selector: "#t1" });
    const pattern = resolveStressPattern(desc, ["#t1"]);
    expect(pattern.steps).toHaveLength(4);
    expect(pattern.steps[0].action).toBe("focus");
    expect(pattern.steps[1]).toEqual({ action: "keyboard", selector: "#t1", key: "ArrowDown" });
    expect(pattern.steps[2]).toEqual({ action: "keyboard", selector: "#t1", key: "Home" });
    expect(pattern.steps[3]).toEqual({ action: "keyboard", selector: "#t1", key: "End" });
  });
});

describe("H6: keyboard-sweep roles with 0 siblings fall through", () => {
  const roles = ["tab", "listbox", "combobox", "menu", "tree"];
  for (const role of roles) {
    it(`${role} + empty siblings → not keyboard-sweep`, () => {
      const desc = makeDescriptor({ type: "click", role });
      const pattern = resolveStressPattern(desc, []);
      expect(pattern.name).not.toBe("keyboard-sweep");
    });
  }
});

describe("H7: open-close-10 always has exactly 20 steps", () => {
  it("triggeredBy descriptor → 20 steps", () => {
    const desc = makeDescriptor({ triggeredBy: "#x", selector: "#btn" });
    expect(resolveStressPattern(desc).steps).toHaveLength(20);
  });

  it("dialog role descriptor → 20 steps", () => {
    const desc = makeDescriptor({ role: "dialog", selector: "#btn" });
    expect(resolveStressPattern(desc).steps).toHaveLength(20);
  });
});

describe("H8: multi-keystroke always has exactly 11 steps", () => {
  it("1 focus + 10 characters = 11", () => {
    const desc = makeDescriptor({ type: "type", selector: "#inp" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.steps).toHaveLength(11);
    expect(pattern.steps[0].action).toBe("focus");
    for (let i = 1; i <= 10; i++) {
      expect(pattern.steps[i].action).toBe("type");
    }
  });
});

describe("H9: rapid-toggle-10 always has exactly 10 steps", () => {
  it("10 click steps", () => {
    const desc = makeDescriptor({ type: "click", selector: "#btn" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.steps).toHaveLength(10);
    for (const step of pattern.steps) {
      expect(step.action).toBe("click");
    }
  });
});

describe("H10: single-shot for keyboard includes key=Enter", () => {
  it("has key: Enter", () => {
    const desc = makeDescriptor({ type: "keyboard", selector: "#el" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.steps[0].key).toBe("Enter");
  });
});

describe("H11: single-shot for select uses select action", () => {
  it("action is select", () => {
    const desc = makeDescriptor({ type: "select", selector: "#sel" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.steps[0].action).toBe("select");
  });
});

describe("H12: single-shot for hover uses hover action", () => {
  it("action is hover", () => {
    const desc = makeDescriptor({ type: "hover", selector: "#h" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.steps[0].action).toBe("hover");
  });
});

describe("H13: portal trigger with type=type → open-close-10 (portal priority)", () => {
  it("open-close-10 wins over multi-keystroke", () => {
    const desc = makeDescriptor({ type: "type", role: "dialog" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("open-close-10");
  });
});

describe("H14: role in KEYBOARD_SWEEP_ROLES + type=hover + siblings → keyboard-sweep", () => {
  it("role check happens before hover check", () => {
    const desc = makeDescriptor({ type: "hover", role: "listbox" });
    const siblings = ["[role=option]:nth-of-type(1)"];
    const pattern = resolveStressPattern(desc, siblings);
    expect(pattern.name).toBe("keyboard-sweep");
  });
});

describe("H15: resolveStressPattern does not modify input descriptor", () => {
  it("descriptor is unchanged after call", () => {
    const desc = makeDescriptor({ type: "click", role: "tab", selector: "#t" });
    const original = JSON.parse(JSON.stringify(desc));
    resolveStressPattern(desc, ["#t"]);
    expect(desc).toEqual(original);
  });
});
