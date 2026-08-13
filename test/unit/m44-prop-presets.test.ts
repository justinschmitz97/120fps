import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  detectPropPresets,
  loadPropPresets,
  applyPropPresets,
  isPresetRef,
  UNKNOWN_PRESET_PROPS_WARNING,
} from "../../src/prop-presets.js";
import {
  presetImportLine,
  presetResolverBlock,
  presetResolveStatement,
  generateEntry,
} from "../../src/harness.js";
import type { PropSchema } from "../../src/prop-gen.js";

const ROOT = path.resolve("fixtures");
const CARD = path.join(ROOT, "m44-preset-card.tsx");

function presets() {
  return loadPropPresets(path.join(ROOT, "m44-preset-card.props.tsx"), ROOT)!;
}

function schema(name: string, values: unknown[]): PropSchema {
  return { name, kind: "string", required: false, values };
}

// C1 — the sidecar is found the way a fixture is.
describe("m44 C1 — preset detection", () => {
  it("finds a .props.tsx next to the component", () => {
    expect(detectPropPresets(CARD)).toBe(path.join(ROOT, "m44-preset-card.props.tsx"));
  });

  it("finds a .props.ts too", () => {
    expect(detectPropPresets(path.join(ROOT, "m44-preset-literal.tsx")))
      .toBe(path.join(ROOT, "m44-preset-literal.props.ts"));
  });

  it("returns nothing for a component without one", () => {
    expect(detectPropPresets(path.join(ROOT, "button.tsx"))).toBeUndefined();
  });
});

// C2 — literals travel as values, everything else as a position.
describe("m44 C2 — value extraction", () => {
  it("reads literal strings as themselves", () => {
    expect(presets().entries.get("title")).toEqual(["Quarterly revenue", "Q"]);
  });

  it("reads nested object arrays as real data", () => {
    const rows = presets().entries.get("rows")!;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual([
      { id: "a", label: "Alpha" },
      { id: "b", label: "Bravo" },
      { id: "c", label: "Charlie" },
    ]);
  });

  it("turns a function into a resolvable reference, not a stub", () => {
    const [ref] = presets().entries.get("onSelect")!;
    expect(isPresetRef(ref)).toBe(true);
    expect(ref).toEqual({ __120fps_preset: "onSelect", index: 0 });
  });

  it("records the module path relative to the project root", () => {
    expect(presets().path).toBe("m44-preset-card.props.tsx");
  });
});

// C3 — presets replace the synthesized pool wherever schemas are read.
describe("m44 C3 — application to schemas", () => {
  it("replaces the value pool rather than extending it", () => {
    const result = applyPropPresets([schema("title", ["synthetic"])], presets());
    expect(result.schemas[0].values).toEqual(["Quarterly revenue", "Q"]);
    expect(result.applied).toEqual(["title"]);
  });

  it("leaves props the preset says nothing about alone", () => {
    const result = applyPropPresets([schema("other", ["synthetic"])], presets());
    expect(result.schemas[0].values).toEqual(["synthetic"]);
    expect(result.applied).toEqual([]);
  });

  it("reports preset names that are not props at all", () => {
    const result = applyPropPresets([schema("title", ["x"])], presets());
    expect(result.unknown).toContain("notAProp");
  });

  it("names them in the warning", () => {
    const warning = UNKNOWN_PRESET_PROPS_WARNING("card.props.tsx", ["notAProp"]);
    expect(warning).toContain("notAProp");
    expect(warning).toContain("ignored");
  });
});

// C4 — the entry resolves references at render time.
describe("m44 C4 — entry wiring", () => {
  it("imports the preset module when one is active", () => {
    expect(presetImportLine("card.props.tsx")).toContain("__120fpsPresets");
  });

  it("emits nothing without a preset", () => {
    expect(presetImportLine(undefined)).toBe("");
    expect(presetResolverBlock(undefined)).toBe("");
    expect(presetResolveStatement(undefined)).toBe("");
  });

  it("resolves props at both entry points", () => {
    const code = generateEntry({
      componentRelative: "Card.tsx",
      componentName: "Card",
      isDefaultExport: true,
      hasScale: false,
      presetRelative: "card.props.tsx",
    });
    const occurrences = code.split("props = __120fpsResolveProps(props);").length - 1;
    expect(occurrences).toBe(2);
  });

  it("leaves a preset-less entry free of any reference to the module", () => {
    const code = generateEntry({
      componentRelative: "Card.tsx",
      componentName: "Card",
      isDefaultExport: true,
      hasScale: false,
    });
    expect(code).not.toContain("__120fpsPresets");
    expect(code).not.toContain("__120fpsResolveProps");
  });
});

// H1..H4 — hardening.
describe("m44 hardening", () => {
  it("H1: a preset module with no default export yields nothing", () => {
    expect(loadPropPresets(path.join(ROOT, "m44-preset-card.tsx"), ROOT)).toBeUndefined();
  });

  it("H2: a missing file yields nothing rather than throwing", () => {
    expect(loadPropPresets(path.join(ROOT, "does-not-exist.props.ts"), ROOT)).toBeUndefined();
  });

  it("H3: a bare (non-array) value becomes a one-element pool", () => {
    expect(loadPropPresets(path.join(ROOT, "m44-preset-literal.props.ts"), ROOT)!
      .entries.get("label")).toEqual(["from-preset"]);
  });

  it("H4: an empty preset pool does not blank out a prop", () => {
    const empty = { path: "p", absolutePath: "p", entries: new Map([["title", []]]) };
    const result = applyPropPresets([schema("title", ["synthetic"])], empty);
    expect(result.schemas[0].values).toEqual(["synthetic"]);
    expect(result.applied).toEqual([]);
  });
});
