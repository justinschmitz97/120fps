import { describe, it, expect } from "vitest";
import { extractProps } from "../../src/prop-gen.js";

describe("extractProps", () => {
  it("extracts variant as union with all members", async () => {
    const schema = await extractProps("./fixtures/button.tsx");
    expect(schema).toContainEqual(
      expect.objectContaining({
        name: "variant",
        kind: "union",
        values: ["primary", "secondary", "ghost"],
      }),
    );
  });

  it("extracts disabled as boolean", async () => {
    const schema = await extractProps("./fixtures/button.tsx");
    expect(schema).toContainEqual(
      expect.objectContaining({
        name: "disabled",
        kind: "boolean",
        values: [true, false],
      }),
    );
  });

  it("extracts onClick as function", async () => {
    const schema = await extractProps("./fixtures/button.tsx");
    expect(schema).toContainEqual(
      expect.objectContaining({
        name: "onClick",
        kind: "function",
      }),
    );
  });

  it("extracts children as reactnode", async () => {
    const schema = await extractProps("./fixtures/button.tsx");
    expect(schema).toContainEqual(
      expect.objectContaining({
        name: "children",
        kind: "reactnode",
      }),
    );
  });

  it("extracts label as string", async () => {
    const schema = await extractProps("./fixtures/button.tsx");
    expect(schema).toContainEqual(
      expect.objectContaining({
        name: "label",
        kind: "string",
        required: true,
      }),
    );
  });

  it("marks optional props correctly", async () => {
    const schema = await extractProps("./fixtures/button.tsx");
    const variant = schema.find((s) => s.name === "variant");
    expect(variant?.required).toBe(false);
    const label = schema.find((s) => s.name === "label");
    expect(label?.required).toBe(true);
  });

  it("returns all 5 props from ButtonProps", async () => {
    const schema = await extractProps("./fixtures/button.tsx");
    const names = schema.map((s) => s.name).sort();
    expect(names).toEqual(
      ["children", "disabled", "label", "onClick", "variant"].sort(),
    );
  });
});
