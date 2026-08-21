import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  explainProps,
  formatExplainProps,
  collapsedUnionBranchesFor,
  explainUnionBranches,
} from "../../src/analyze.js";

// excalidraw-F4: `--explain-props` on ConfirmDialog printed
// `size  union  optional  "small"` and, two lines below,
// `union of 4 different shapes (number | "small" | "regular" | "wide")`.
// A reader of the table alone believed "small" was the only accepted value.

const FIXTURE = path.resolve("fixtures/collapsed-union-size/ConfirmDialog.tsx");

describe("the value column and the union warning describe the same prop", () => {
  it("lists every literal branch and names the collapsed non-literal one", async () => {
    const explained = await explainProps(FIXTURE);
    const size = explained.props.find((p) => p.name === "size")!;
    expect(size.unionBranches).toEqual(['number', '"small"', '"regular"', '"wide"']);

    const table = formatExplainProps(explained);
    const row = table.split("\n").find((l) => l.trim().startsWith("size"))!;
    expect(row).toContain('"small", "regular", "wide"');
    expect(row).toContain("(+ number)");

    // The warning is still printed, and now says nothing the row denies.
    const warning = explained.warnings.find((w) => w.includes("union of 4 different shapes"))!;
    expect(warning).toBeDefined();
    for (const literal of ["small", "regular", "wide"]) {
      expect(row).toContain(literal);
      expect(warning).toContain(literal);
    }
  });

  it("leaves a prop with no collapsed union untouched", async () => {
    const explained = await explainProps(FIXTURE);
    const title = explained.props.find((p) => p.name === "title")!;
    expect(title.unionBranches).toBeUndefined();
  });
});

describe("branch rendering", () => {
  it("caps a long literal list the same way the value column does", () => {
    const branches = ['"a"', '"b"', '"c"', '"d"', '"e"', '"f"'];
    expect(explainUnionBranches(branches)).toBe('"a", "b", "c", "d", +2 more');
  });

  it("names several collapsed non-literal branches", () => {
    expect(explainUnionBranches(['"a"', "number", "ReactElement"]))
      .toBe('"a" (+ number, ReactElement)');
  });

  it("says so when a union collapsed to no literal at all", () => {
    expect(explainUnionBranches(["number", "ReactElement"]))
      .toBe("(no literal values) (+ number, ReactElement)");
  });

  it("reads the branch list back from the warning that named it", () => {
    const warnings = [
      'Warning: prop "size" in /p/C.tsx is a union of 4 different shapes (number | "small" | "regular" | "wide"); measured as union. Add C.props.tsx to choose a different branch.',
    ];
    expect(collapsedUnionBranchesFor("size", warnings)).toEqual(['number', '"small"', '"regular"', '"wide"']);
    expect(collapsedUnionBranchesFor("other", warnings)).toBeUndefined();
  });
});
