import { describe, it, expect } from "vitest";
import path from "node:path";
import { namedStringValue, extractProps } from "../../src/props/index.js";

const fixture = (rel: string): string => path.resolve("fixtures", rel);

describe("the value a dimension-named string prop gets", () => {
  it("is a number the browser accepts as a length", () => {
    for (const name of ["size", "width", "height", "strokeWidth", "x", "y", "r", "cx", "cy", "rx", "ry"]) {
      expect(namedStringValue(name)).toBe("16");
    }
  });

  it("is case-insensitive, as the other name rules are", () => {
    expect(namedStringValue("Width")).toBe("16");
    expect(namedStringValue("STROKEWIDTH")).toBe("16");
  });

  it("is not given to a prop whose name means something else", () => {
    for (const name of ["label", "title", "sizeLabel", "widthClass", "maxWidth"]) {
      expect(namedStringValue(name)).toBeUndefined();
    }
  });
});

describe("the schema a dimension prop produces", () => {
  it("records the number and marks it as a heuristic", async () => {
    const schemas = await extractProps(fixture("dimension-props/loader.tsx"), {
      onWarning: () => {},
    });
    for (const name of ["size", "width", "strokeWidth"]) {
      const schema = schemas.find((s) => s.name === name);
      expect(schema?.kind).toBe("string");
      expect(schema?.values).toEqual(["16"]);
      expect(schema?.provenance).toBe("heuristic");
    }
  });

  it("leaves a plain string prop on the generic placeholder", async () => {
    const schemas = await extractProps(fixture("dimension-props/loader.tsx"), {
      onWarning: () => {},
    });
    const label = schemas.find((s) => s.name === "label");
    expect(label?.values).toEqual(["test"]);
    expect(label?.provenance).toBe("placeholder");
  });

  it("leaves a number prop untouched", async () => {
    const schemas = await extractProps(fixture("dimension-props/loader.tsx"), {
      onWarning: () => {},
    });
    const count = schemas.find((s) => s.name === "count");
    expect(count?.kind).toBe("number");
    expect(count?.values).toEqual([1, 5, 20]);
  });

  it("leaves a literal union named size untouched", async () => {
    const schemas = await extractProps(fixture("dimension-props/sized-union.tsx"), {
      onWarning: () => {},
    });
    const size = schemas.find((s) => s.name === "size");
    expect(size?.values).toEqual(["sm", "lg"]);
    expect(size?.provenance).toBe("declared");
  });
});
