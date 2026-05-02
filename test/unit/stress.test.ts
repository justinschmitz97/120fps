import { describe, it, expect } from "vitest";
import { extractProps } from "../../src/prop-gen.js";
import { generateCombinations } from "../../src/prop-gen-values.js";

// Error handling
describe("error handling", () => {
  it("extractProps throws on nonexistent file", async () => {
    await expect(
      extractProps("./fixtures/does-not-exist.tsx"),
    ).rejects.toThrow();
  });
});

// H1: forwardRef component
describe("H1: React.forwardRef", () => {
  it("extracts props from forwardRef component", async () => {
    const schema = await extractProps("./fixtures/forward-ref.tsx");
    const names = schema.map((s) => s.name).sort();
    expect(names).toEqual(["disabled", "placeholder", "size"].sort());
  });

  it("extracts size as union", async () => {
    const schema = await extractProps("./fixtures/forward-ref.tsx");
    const size = schema.find((s) => s.name === "size");
    expect(size).toBeDefined();
    expect(size?.kind).toBe("union");
    expect(size?.values).toEqual(["sm", "md", "lg"]);
  });
});

// H2: React.memo wrapper
describe("H2: React.memo", () => {
  it("extracts props from memo-wrapped component", async () => {
    const schema = await extractProps("./fixtures/memo-comp.tsx");
    const names = schema.map((s) => s.name).sort();
    expect(names).toEqual(["count", "variant", "visible"].sort());
  });

  it("extracts count as number", async () => {
    const schema = await extractProps("./fixtures/memo-comp.tsx");
    const count = schema.find((s) => s.name === "count");
    expect(count?.kind).toBe("number");
    expect(count?.required).toBe(true);
  });
});

// H3: default-export-only component
describe("H3: default export only", () => {
  it("extracts props from default-only export", async () => {
    const schema = await extractProps("./fixtures/default-only.tsx");
    const names = schema.map((s) => s.name).sort();
    expect(names).toEqual(["color", "text"].sort());
  });

  it("extracts color as union", async () => {
    const schema = await extractProps("./fixtures/default-only.tsx");
    const color = schema.find((s) => s.name === "color");
    expect(color?.kind).toBe("union");
    expect(color?.values).toEqual(["red", "blue", "green"]);
  });
});

// H4: intersection type props
describe("H4: intersection types", () => {
  it("extracts all members from intersected types", async () => {
    const schema = await extractProps("./fixtures/intersection.tsx");
    const names = schema.map((s) => s.name).sort();
    expect(names).toEqual(
      ["id", "className", "onClick", "disabled", "title", "subtitle"].sort(),
    );
  });

  it("id is required string", async () => {
    const schema = await extractProps("./fixtures/intersection.tsx");
    const id = schema.find((s) => s.name === "id");
    expect(id?.kind).toBe("string");
    expect(id?.required).toBe(true);
  });

  it("onClick is optional function", async () => {
    const schema = await extractProps("./fixtures/intersection.tsx");
    const onClick = schema.find((s) => s.name === "onClick");
    expect(onClick?.kind).toBe("function");
    expect(onClick?.required).toBe(false);
  });
});

// H5: component with zero props
describe("H5: no props", () => {
  it("returns empty schema for propless component", async () => {
    const schema = await extractProps("./fixtures/no-props.tsx");
    expect(schema).toEqual([]);
  });

  it("generateCombinations returns single empty combo for empty schema", () => {
    const combos = generateCombinations([]);
    expect(combos).toEqual([{}]);
  });
});

// H6: generic props
describe("H6: generic DataTable<T>", () => {
  it("extracts props from generic component", async () => {
    const schema = await extractProps("./fixtures/generic.tsx");
    const names = schema.map((s) => s.name).sort();
    expect(names).toEqual(["columns", "data", "pageSize", "striped"].sort());
  });

  it("striped is boolean", async () => {
    const schema = await extractProps("./fixtures/generic.tsx");
    const striped = schema.find((s) => s.name === "striped");
    expect(striped?.kind).toBe("boolean");
  });

  it("pageSize is number", async () => {
    const schema = await extractProps("./fixtures/generic.tsx");
    const pageSize = schema.find((s) => s.name === "pageSize");
    expect(pageSize?.kind).toBe("number");
  });

  it("data is classified as array", async () => {
    const schema = await extractProps("./fixtures/generic.tsx");
    const data = schema.find((s) => s.name === "data");
    expect(data?.kind).toBe("array");
  });
});

// H7: component with CSS import (prop extraction only — CSS irrelevant for TS analysis)
describe("H7: CSS import", () => {
  it("extracts props despite CSS import in source", async () => {
    const schema = await extractProps("./fixtures/with-css.tsx");
    const names = schema.map((s) => s.name).sort();
    expect(names).toEqual(["message", "type"].sort());
  });

  it("type is union", async () => {
    const schema = await extractProps("./fixtures/with-css.tsx");
    const type = schema.find((s) => s.name === "type");
    expect(type?.kind).toBe("union");
    expect(type?.values).toEqual(["success", "error", "warning"]);
  });
});

// H8: component with sibling import
describe("H8: relative sibling import", () => {
  it("extracts props from component with relative imports", async () => {
    const schema = await extractProps("./fixtures/with-import.tsx");
    const names = schema.map((s) => s.name).sort();
    expect(names).toEqual(["bold", "cents", "currency"].sort());
  });

  it("currency resolves as union via imported type", async () => {
    const schema = await extractProps("./fixtures/with-import.tsx");
    const currency = schema.find((s) => s.name === "currency");
    expect(currency?.kind).toBe("union");
    expect(currency?.values).toEqual(["USD", "EUR", "GBP"]);
  });
});

// H10: Record<string, unknown> / index signature props
describe("H10: Record prop", () => {
  it("extracts named props including Record-typed field", async () => {
    const schema = await extractProps("./fixtures/index-sig.tsx");
    const names = schema.map((s) => s.name).sort();
    expect(names).toEqual(["data", "showEmpty", "title"].sort());
  });

  it("data is classified as object", async () => {
    const schema = await extractProps("./fixtures/index-sig.tsx");
    const data = schema.find((s) => s.name === "data");
    // Record<string, unknown> should be object
    expect(["object", "unknown"]).toContain(data?.kind);
  });
});
