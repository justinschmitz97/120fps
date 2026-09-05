import { describe, it, expect } from "vitest";
import path from "node:path";
import { extractProps, type PropSchema } from "../../src/props/index.js";
import {
  generatePropMatrix,
  matrixAxesFor,
  matrixHeldAbsentProps,
  matrixValues,
} from "../../src/props/index.js";

const DIALOG = path.resolve(__dirname, "../../fixtures/controlled-pair/Dialog.tsx");
const DIALOG_DEFAULTS = path.resolve(
  __dirname,
  "../../fixtures/controlled-pair/DialogDefaults.tsx",
);

// fluentui-F1: all four Dialog cells set `open`/`defaultOpen` together, which the hook rejects.

describe("a matrix over a controlled/uncontrolled prop pair", () => {
  let schemas: PropSchema[];

  it("crosses the controlled member and drops its default twin", async () => {
    schemas = await extractProps(DIALOG);
    const axes = matrixAxesFor(schemas).map((a) => a.propName);

    expect(axes).toContain("open");
    expect(axes).not.toContain("defaultOpen");
  });

  it("names the dropped twin as held absent", async () => {
    schemas = await extractProps(DIALOG);

    expect(matrixHeldAbsentProps(schemas)).toContain("defaultOpen");
  });

  it("sets no cell that carries both members of the pair", async () => {
    schemas = await extractProps(DIALOG);
    const cells = generatePropMatrix(schemas);

    expect(cells.length).toBeGreaterThan(1);
    for (const cell of cells) {
      expect("defaultOpen" in cell && "open" in cell).toBe(false);
      expect("defaultOpen" in cell).toBe(false);
    }
  });
});

describe("the values a boolean axis is crossed over", () => {
  let schemas: PropSchema[];
  const of = (name: string) => schemas.find((s) => s.name === name)!;

  it("crosses absent against present for an optional boolean", async () => {
    schemas = await extractProps(DIALOG);

    expect(matrixValues(of("open"))).toEqual([undefined, true]);
  });

  it("keeps false and true for a required boolean", async () => {
    schemas = await extractProps(DIALOG);

    expect(matrixValues(of("modal"))).toEqual([false, true]);
  });

  it("leaves the absent member out of the cell it belongs to", async () => {
    schemas = await extractProps(DIALOG);
    const cells = generatePropMatrix(schemas);

    expect(cells.some((cell) => !("open" in cell))).toBe(true);
    expect(cells.some((cell) => cell.open === true)).toBe(true);
    expect(cells.every((cell) => "modal" in cell)).toBe(true);
  });
});

// See specs/milestones/m114-disclosures-are-true-for-runtime-styling-props-and-page-errors.md B3.

describe("a matrix over a pair whose twin declares a default", () => {
  let schemas: PropSchema[];

  it("sets the twin in no cell and names it as held absent", async () => {
    schemas = await extractProps(DIALOG_DEFAULTS);
    const cells = generatePropMatrix(schemas);

    expect(cells.length).toBeGreaterThan(1);
    for (const cell of cells) expect("defaultOpen" in cell).toBe(false);
    expect(matrixHeldAbsentProps(schemas)).toContain("defaultOpen");
  });

  it("crosses absence against the state a defaulted-true boolean is not already in", async () => {
    schemas = await extractProps(DIALOG_DEFAULTS);
    const unmountOnClose = schemas.find((s) => s.name === "unmountOnClose")!;

    expect(unmountOnClose.defaultValue).toBe(true);
    expect(matrixValues(unmountOnClose)).toEqual([undefined, false]);
  });
});
