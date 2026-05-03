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
    expect(pattern.name).toBe("rapid-toggle-10");
  });
});

// H3: range input with aria-orientation=vertical gets vertical direction
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

// H5: ariaValueNow + slider role doesn't double-trigger
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

// H6: zero-width bounding rect — pattern generation is unaffected (execution handles it)
describe("H6: pattern generation independent of bounding rect", () => {
  it("pattern is generated without bounding rect info", () => {
    const desc = makeDescriptor({ role: "slider", selector: "#zero-width" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.steps[0].moveCount).toBe(60);
    expect(pattern.steps[0].direction).toBe("horizontal");
  });
});

// H7: moveCount is always 60 from buildPointerDrag
describe("H7: moveCount consistency", () => {
  it("moveCount is always 60 regardless of descriptor", () => {
    const cases = [
      makeDescriptor({ role: "slider" }),
      makeDescriptor({ inputType: "range", tagName: "INPUT" }),
      makeDescriptor({ ariaValueNow: true }),
      makeDescriptor({ cursor: "grab" }),
    ];
    for (const desc of cases) {
      const pattern = resolveStressPattern(desc);
      expect(pattern.steps[0].moveCount).toBe(60);
    }
  });
});

// H8: empty cursor string does not trigger
describe("H8: empty cursor", () => {
  it("cursor='' does not trigger pointer-drag", () => {
    const desc = makeDescriptor({ cursor: "" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).not.toBe("pointer-drag");
  });
});

// H9: range input detected without slider role
describe("H9: range without slider role", () => {
  it("input[type=range] without role still triggers pointer-drag", () => {
    const desc = makeDescriptor({ tagName: "INPUT", inputType: "range" });
    expect(desc.role).toBeUndefined();
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("pointer-drag");
  });
});

// H10: element with grab cursor but no role triggers
describe("H10: grab cursor without role", () => {
  it("element with cursor=grab and no role triggers pointer-drag", () => {
    const desc = makeDescriptor({ cursor: "grab", tagName: "DIV" });
    expect(desc.role).toBeUndefined();
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("pointer-drag");
  });
});

// H11: explicit aria-orientation=horizontal produces horizontal
describe("H11: explicit horizontal orientation", () => {
  it("aria-orientation=horizontal produces horizontal direction", () => {
    const desc = makeDescriptor({ role: "slider", ariaOrientation: "horizontal" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.steps[0].direction).toBe("horizontal");
  });
});

// H12: portal slider still gets pointer-drag
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

// H14: cursor "default" does not trigger
describe("H14: cursor default", () => {
  it("cursor=default does not trigger pointer-drag", () => {
    const desc = makeDescriptor({ cursor: "default" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).not.toBe("pointer-drag");
  });
});

// H15: all three drag cursors work
describe("H15: all drag cursor values", () => {
  it.each(["grab", "col-resize", "row-resize"])("cursor=%s triggers pointer-drag", (cursor) => {
    const desc = makeDescriptor({ cursor });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("pointer-drag");
  });
});

// H16: ariaValueNow=false does not trigger
describe("H16: ariaValueNow false", () => {
  it("ariaValueNow=false does not trigger pointer-drag", () => {
    const desc = makeDescriptor({ ariaValueNow: false });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).not.toBe("pointer-drag");
  });
});

// H17: stressPattern field on edge records "pointer-drag" (via explorer integration)
describe("H17: pattern name in steps", () => {
  it("pattern name is 'pointer-drag'", () => {
    const desc = makeDescriptor({ role: "slider" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("pointer-drag");
  });
});

// H18: slider does not fall through to keyboard-sweep even with siblings
describe("H18: slider never keyboard-sweep", () => {
  it("slider with keyboard-sweep-eligible role and siblings still gets pointer-drag", () => {
    const desc = makeDescriptor({ role: "slider" });
    const siblings = ["#s1", "#s2", "#s3"];
    const pattern = resolveStressPattern(desc, siblings);
    expect(pattern.name).toBe("pointer-drag");
  });
});

// H19: unknown aria-orientation value defaults to horizontal
describe("H19: unknown aria-orientation", () => {
  it("aria-orientation=diagonal defaults to horizontal", () => {
    const desc = makeDescriptor({ role: "slider", ariaOrientation: "diagonal" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.steps[0].direction).toBe("horizontal");
  });
});

// H20: triggeredBy does not prevent drag detection
describe("H20: triggeredBy + slider", () => {
  it("slider with triggeredBy still gets pointer-drag (not open-close-10)", () => {
    const desc = makeDescriptor({ role: "slider", triggeredBy: "#trigger" });
    const pattern = resolveStressPattern(desc);
    expect(pattern.name).toBe("pointer-drag");
  });
});
