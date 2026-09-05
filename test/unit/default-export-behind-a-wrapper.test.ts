import { describe, it, expect } from "vitest";
import path from "node:path";
import { scanExports } from "../../src/props/index.js";
import fs from "node:fs";
import { detectComponentExport } from "../../src/harness/index.js";

const FIXTURES = path.resolve(__dirname, "../../fixtures");

const exportsOf = (file: string) => scanExports(fs.readFileSync(file, "utf-8"), file);

// logto-F1: forwardRef(Button) default read as none; picker fell to the first non-Provider export.

describe("a default export written as a call wrapper", () => {
  it("binds the identifier the wrapper names", () => {
    const file = path.join(FIXTURES, "m58/hoc-default.tsx");

    expect(exportsOf(file)).toContainEqual({ name: "Chart", isDefault: true });
    expect(detectComponentExport(file).name).toBe("Chart");
  });

  it("unwraps a nested memo(forwardRef(X)) chain", () => {
    const file = path.join(FIXTURES, "wrapped-default/Button.tsx");

    expect(exportsOf(file)).toContainEqual({ name: "Button", isDefault: true });
  });

  it("never prefers a named sibling over the explicit default", () => {
    const file = path.join(FIXTURES, "wrapped-default/Button.tsx");

    expect(exportsOf(file).map((e) => e.name)).toContain("LinkButton");
    expect(detectComponentExport(file).name).toBe("Button");
  });
});
