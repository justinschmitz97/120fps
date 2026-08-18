import { describe, it, expect } from "vitest";
import {
  generateEntry,
  generateComposedEntry,
  setupBlock,
  setupApiBlock,
  WRAPPER_SETUP_TIMEOUT_MS,
} from "../../src/harness.js";
import { generateProbeEntry } from "../../src/react-profiler.js";
import type { CompositionTree } from "../../src/composition.js";

const WRAP = "120fps.setup.tsx";

function entry(wrapRelative?: string): string {
  return generateEntry({
    componentRelative: "Button.tsx",
    componentName: "Button",
    isDefaultExport: true,
    hasScale: false,
    wrapRelative,
  });
}

const TREE: CompositionTree = {
  root: "Panel",
  structure: [{ component: "Panel", props: {}, children: [] }],
} as unknown as CompositionTree;

function composed(wrapRelative?: string): string {
  return generateComposedEntry("Panel.tsx", TREE, [{ name: "Panel", isDefault: true }] as any, wrapRelative);
}

function probe(wrapRelative?: string): string {
  return generateProbeEntry({
    componentRelative: "Button.tsx",
    componentName: "Button",
    isDefaultExport: true,
    wrapRelative,
  });
}

const API_ASSIGNMENT = "(window as any).__120fps = {";

// C1: readiness implies setup completed.
describe("setup runs before the control API is exposed", () => {
  for (const [name, build] of [
    ["standard", entry],
    ["composed", composed],
    ["probe", probe],
  ] as const) {
    it(`awaits setup ahead of the control API in the ${name} entry`, () => {
      const code = build(WRAP);
      const setupAt = code.indexOf("__120fpsSetup");
      const apiAt = code.indexOf(API_ASSIGNMENT);
      expect(setupAt).toBeGreaterThan(-1);
      expect(apiAt).toBeGreaterThan(-1);
      expect(setupAt).toBeLessThan(apiAt);
      expect(code).toContain("await Promise.race");
    });

    it(`emits nothing about setup in the ${name} entry without a wrapper`, () => {
      const code = build(undefined);
      expect(code).not.toContain("__120fpsSetup");
      expect(code).not.toContain("__120fpsWrapModule");
      expect(code).not.toContain("teardown");
    });
  }
});

// C2: an unbounded setup would hang the run behind a readiness timeout.
describe("setup is bounded", () => {
  it("races setup against the timeout", () => {
    expect(setupBlock(WRAP)).toContain(String(WRAPPER_SETUP_TIMEOUT_MS));
  });

  it("defaults to 15s", () => {
    expect(WRAPPER_SETUP_TIMEOUT_MS).toBe(15000);
  });

  it("names the wrapper contract in the timeout message", () => {
    expect(setupBlock(WRAP)).toContain("wrapper setup");
  });

  it("emits nothing without a wrapper", () => {
    expect(setupBlock(undefined)).toBe("");
    expect(setupApiBlock(undefined)).toBe("");
  });
});

// C3: the report says whether setup was in play.
describe("the control API discloses setup", () => {
  it("exposes hasSetup and teardown when a wrapper is present", () => {
    const code = setupApiBlock(WRAP);
    expect(code).toContain("hasSetup");
    expect(code).toContain("teardown");
  });

  it("assigns hasSetup from the wrapper export, not a constant", () => {
    expect(setupApiBlock(WRAP)).toContain("typeof __120fpsSetup === \"function\"");
  });
});
