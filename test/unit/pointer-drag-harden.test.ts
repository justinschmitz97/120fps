import { describe, it, expect } from "vitest";
import { resolveStressPattern } from "../../src/analysis/index.js";
import type { InteractionDescriptor } from "../../src/browser/index.js";

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

// H1: cursor "grabbing" should NOT trigger pointer-drag (it's the active state, not the idle state)
describe("H1: cursor grabbing", () => {
  it("cursor=grabbing does not trigger pointer-drag", () => {
    const desc = makeDescriptor({ cursor: "grabbing" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).not.toBe("pointer-drag");
  });
});

// H2: cursor "pointer" is a regular clickable cursor, must not trigger
describe("H2: cursor pointer", () => {
  it("cursor=pointer does not trigger pointer-drag", () => {
    const desc = makeDescriptor({ cursor: "pointer" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("rapid-toggle-11");
  });
});

describe("H3: range input vertical orientation", () => {
  it("range input with aria-orientation=vertical produces vertical step", () => {
    const desc = makeDescriptor({
      tagName: "INPUT",
      inputType: "range",
      ariaOrientation: "vertical",
    });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("pointer-drag");
    expect(pattern.steps[0].direction).toBe("vertical");
  });
});

// H4: empty selector still produces valid pattern (execution handles missing elements)
describe("H4: empty selector", () => {
  it("produces valid pattern with empty selector", () => {
    const desc = makeDescriptor({ role: "slider", selector: "" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("pointer-drag");
    expect(pattern.steps[0].selector).toBe("");
  });
});

describe("H5: redundant drag signals", () => {
  it("slider + ariaValueNow = single pointer-drag pattern", () => {
    const desc = makeDescriptor({
      role: "slider",
      ariaValueNow: true,
      cursor: "grab",
    });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("pointer-drag");
    expect(pattern.steps).toHaveLength(1);
  });
});

describe("H8: empty cursor", () => {
  it("cursor='' does not trigger pointer-drag", () => {
    const desc = makeDescriptor({ cursor: "" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).not.toBe("pointer-drag");
  });
});

describe("H12: portal slider", () => {
  it("slider with portal=true still gets pointer-drag", () => {
    const desc = makeDescriptor({ role: "slider", portal: true });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("pointer-drag");
  });
});

// H13: cursor "auto" (the CSS default) does not trigger
describe("H13: cursor auto", () => {
  it("cursor=auto does not trigger pointer-drag", () => {
    const desc = makeDescriptor({ cursor: "auto" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).not.toBe("pointer-drag");
  });
});

describe("H14: cursor default", () => {
  it("cursor=default does not trigger pointer-drag", () => {
    const desc = makeDescriptor({ cursor: "default" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).not.toBe("pointer-drag");
  });
});

describe("H15: all drag cursor values", () => {
  it.each(["grab", "col-resize", "row-resize"])("cursor=%s triggers pointer-drag", (cursor) => {
    const desc = makeDescriptor({ cursor });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("pointer-drag");
  });
});

describe("H16: ariaValueNow false", () => {
  it("ariaValueNow=false does not trigger pointer-drag", () => {
    const desc = makeDescriptor({ ariaValueNow: false });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).not.toBe("pointer-drag");
  });
});

describe("H20: triggeredBy + slider", () => {
  it("slider with triggeredBy still gets pointer-drag (not open-close-10)", () => {
    const desc = makeDescriptor({ role: "slider", triggeredBy: "#trigger" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("pointer-drag");
  });
});
