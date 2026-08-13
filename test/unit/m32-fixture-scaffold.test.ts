import { describe, it, expect } from "vitest";
import { buildFixtureScaffold, fixtureScaffoldPath } from "../../src/composition.js";
import type { CompositionTree } from "../../src/composition.js";

const TREE: CompositionTree = {
  root: "Select",
  structure: [
    {
      component: "Select",
      props: { defaultValue: "0" },
      children: [
        { component: "SelectTrigger", props: {}, children: [] },
        { component: "SelectContent", props: {}, children: [] },
      ],
    },
  ],
  repeatNode: "SelectItem",
  repeatCount: 3,
};

const EXPORTS = [
  { name: "Select", isDefault: false },
  { name: "SelectTrigger", isDefault: false },
  { name: "SelectContent", isDefault: false },
  { name: "SelectItem", isDefault: false },
];

describe("m32 D2 — fixture scaffolding", () => {
  const source = buildFixtureScaffold("select", EXPORTS, TREE);

  it("imports every export from the component next to it", () => {
    expect(source).toContain('from "./select"');
    for (const name of ["Select", "SelectTrigger", "SelectContent", "SelectItem"]) {
      expect(source).toContain(name);
    }
  });

  it("renders the attempted tree as JSX", () => {
    expect(source).toContain("<Select");
    expect(source).toContain("<SelectTrigger");
    expect(source).toContain("<SelectContent");
  });

  it("has a default export so the fixture pipeline can mount it", () => {
    expect(source).toMatch(/export default function/);
  });

  it("flags exports the inference could not place", () => {
    expect(source).toContain("TODO");
    expect(source).toContain("SelectItem");
  });

  it("says why the file exists", () => {
    expect(source.toLowerCase()).toContain("auto-composition");
  });

  it("derives the path from the component, not the export name", () => {
    expect(fixtureScaffoldPath("/p/src/ui/select.tsx")).toBe("/p/src/ui/select.fixture.tsx");
    expect(fixtureScaffoldPath("C:\\p\\src\\ui\\select.tsx")).toBe("C:\\p\\src\\ui\\select.fixture.tsx");
  });

  it("handles a tree with no placeable children", () => {
    const flat: CompositionTree = {
      root: "Thing",
      structure: [{ component: "Thing", props: {}, children: [] }],
      repeatCount: 1,
    };
    const out = buildFixtureScaffold("thing", [{ name: "Thing", isDefault: true }], flat);
    expect(out).toContain("<Thing");
    expect(out).toMatch(/export default function/);
  });
});

describe("m32 D2 — the scaffold must be valid JSX", () => {
  const withTodo = buildFixtureScaffold("select", EXPORTS, TREE);

  it("wraps multiple top-level children in a fragment", () => {
    const body = withTodo.slice(withTodo.indexOf("return ("));
    expect(body).toContain("<>");
    expect(body).toContain("</>");
  });

  it("imports without a .js extension so bundler resolution finds the tsx", () => {
    expect(withTodo).toContain('from "./select"');
    expect(withTodo).not.toContain('from "./select.js"');
  });

  it("parses as a module", async () => {
    const ts = (await import("typescript")).default;
    const out = ts.transpileModule(withTodo, {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ESNext },
      reportDiagnostics: true,
    });
    expect(out.diagnostics ?? []).toEqual([]);
  });

  it("parses as a module with nothing to flag", async () => {
    const ts = (await import("typescript")).default;
    const flat = buildFixtureScaffold(
      "thing",
      [{ name: "Thing", isDefault: true }],
      { root: "Thing", structure: [{ component: "Thing", props: {}, children: [] }], repeatCount: 1 },
    );
    const out = ts.transpileModule(flat, {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ESNext },
      reportDiagnostics: true,
    });
    expect(out.diagnostics ?? []).toEqual([]);
  });
});
