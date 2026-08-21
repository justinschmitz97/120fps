import { describe, it, expect } from "vitest";
import path from "node:path";
import { explainProps, formatExplainProps } from "../../src/analyze.js";

// calcom-F2: extraction has carried `defaultValue`/`defaultSource` since I8 --
// calcom Button declares six of them inside the measured 32 -- and
// `--explain-props` printed no default column at all, so the tool knew the
// defaults and never said so. This goes through `explainProps`, the path the
// CLI actually calls, rather than through `extractProps` alone.

const FIXTURE = path.resolve("fixtures/own-props-rank/DefaultsButton.tsx");

describe("the dry run prints the defaults the component declares", () => {
  it("carries the value and its source onto the explained prop", async () => {
    const explained = await explainProps(FIXTURE);
    expect(explained.props.find((p) => p.name === "color")).toMatchObject({
      defaultValue: "primary",
      defaultSource: "destructuring",
    });
  });

  it("keeps a falsy default, which presence-not-truthiness is what decides", async () => {
    const explained = await explainProps(FIXTURE);
    const loading = explained.props.find((p) => p.name === "loading")!;
    expect(loading.defaultValue).toBe(false);
    expect("defaultValue" in loading).toBe(true);
  });

  it("prints a default column with a header naming it", async () => {
    const table = formatExplainProps(await explainProps(FIXTURE));
    expect(table).toMatch(/prop\s+type\s+required\s+default\s+value/);
    const colorRow = table.split("\n").find((l) => l.trim().startsWith("color"))!;
    expect(colorRow).toContain('"primary"');
  });

  it("leaves the cell blank for a prop that declares no default", async () => {
    const explained = await explainProps(FIXTURE);
    const table = formatExplainProps(explained);
    const undefaulted = explained.props.find((p) => p.defaultValue === undefined)!;
    const row = table.split("\n").find((l) => l.trim().startsWith(undefaulted.name))!;
    expect(row).not.toContain("undefined");
  });

  it("prints no default column for a component that declares none", async () => {
    const table = formatExplainProps(
      await explainProps(path.resolve("fixtures/collapsed-union-size/ConfirmDialog.tsx")),
    );
    expect(table).not.toMatch(/prop\s+type\s+required\s+default/);
  });
});
