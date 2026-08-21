import { describe, it, expect } from "vitest";
import path from "node:path";
import { applyPropPresets, loadPropPresets } from "../../src/prop-presets.js";
import type { PropPresets } from "../../src/prop-presets.js";
import type { PropSchema } from "../../src/prop-gen.js";

const FIXTURES = path.resolve(__dirname, "../../fixtures/vue-dual-block");

function presets(entries: Record<string, unknown[]>): PropPresets {
  return {
    path: "Badge.props.tsx",
    absolutePath: "/repo/Badge.props.tsx",
    entries: new Map(Object.entries(entries)),
  };
}

function schema(name: string): PropSchema {
  return { name, kind: "string", required: false, values: ["test"] };
}

// primevue-F1: 271 of 279 components declare props through `extends`, an ADR 0002
// exclusion whose warning names `<stem>.props.tsx` as the remedy. `applyPropPresets`
// was `schemas.map(...)`, so with nothing extracted the remedy could never apply.

describe("a preset for a component whose extraction produced nothing", () => {
  it("adds a schema for every preset key", () => {
    const result = applyPropPresets(
      [],
      presets({ value: ["2"], severity: ["success"], size: ["large"] }),
    );

    expect(result.schemas.map((s) => s.name)).toEqual(["value", "severity", "size"]);
    expect(result.unknown).toEqual([]);
  });

  it("marks every added schema as preset-provided and optional", () => {
    const result = applyPropPresets([], presets({ value: ["2"] }));

    expect(result.schemas[0]).toMatchObject({
      name: "value",
      provenance: "preset",
      required: false,
      values: ["2"],
    });
  });

  it("reports the added props as applied, so the report can name them", () => {
    const result = applyPropPresets([], presets({ value: ["2"], size: ["large"] }));

    expect(result.applied).toEqual(["value", "size"]);
  });

  it("infers the kind from the preset's own values", () => {
    const result = applyPropPresets(
      [],
      presets({
        label: ["hi"],
        count: [3],
        disabled: [true],
        items: [[1, 2]],
        style: [{ color: "red" }],
      }),
    );

    const kinds = Object.fromEntries(result.schemas.map((s) => [s.name, s.kind]));
    expect(kinds).toEqual({
      label: "string",
      count: "number",
      disabled: "boolean",
      items: "array",
      style: "object",
    });
  });

  it("calls a pool of mixed types a union", () => {
    const result = applyPropPresets([], presets({ value: ["2", 3] }));

    expect(result.schemas[0].kind).toBe("union");
  });

  it("falls back to unknown for a value the preset file could not read", () => {
    const result = applyPropPresets([], presets({ icon: [{ __120fps_preset: "icon", index: 0 }] }));

    expect(result.schemas[0].kind).toBe("unknown");
  });

  it("skips a preset key whose value list is empty", () => {
    const result = applyPropPresets([], presets({ value: [] }));

    expect(result.schemas).toEqual([]);
  });
});

describe("a preset for a component whose extraction succeeded", () => {
  it("still reports a key that is not one of the extracted props", () => {
    const result = applyPropPresets([schema("label")], presets({ label: ["a"], nope: ["b"] }));

    expect(result.schemas.map((s) => s.name)).toEqual(["label"]);
    expect(result.unknown).toEqual(["nope"]);
  });

  it("keeps replacing the value pool of a prop it does know", () => {
    const result = applyPropPresets([schema("label")], presets({ label: ["a", "b"] }));

    expect(result.schemas[0]).toMatchObject({ values: ["a", "b"], provenance: "preset" });
    expect(result.applied).toEqual(["label"]);
  });
});

describe("the escape hatch on a real Options-API SFC", () => {
  it("loads the preset file beside the component", () => {
    const loaded = loadPropPresets(
      path.join(FIXTURES, "OptionsExtends.props.tsx"),
      FIXTURES,
    );

    expect([...loaded.entries.keys()]).toEqual(["value", "severity", "size"]);
  });

  it("turns that preset into the component's measured props", () => {
    const loaded = loadPropPresets(
      path.join(FIXTURES, "OptionsExtends.props.tsx"),
      FIXTURES,
    );
    const result = applyPropPresets([], loaded);

    expect(result.schemas.map((s) => s.name)).toEqual(["value", "severity", "size"]);
    expect(result.schemas.every((s) => s.provenance === "preset")).toBe(true);
    expect(result.unknown).toEqual([]);
  });
});
