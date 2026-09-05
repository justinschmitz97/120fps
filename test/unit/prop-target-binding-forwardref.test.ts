import { describe, it, expect } from "vitest";
import path from "node:path";
import { extractProps } from "../../src/props/index.js";
import type { PropSchema } from "../../src/props/index.js";

const M81 = path.resolve("./fixtures/m81");
const fixture = (name: string): string => path.join(M81, name);

const requiredMap = (schemas: PropSchema[]): Record<string, boolean> =>
  Object.fromEntries(schemas.map((s) => [s.name, s.required]));

const EXPECTED = { id: true, label: false, count: false, active: false };

// M81 §5 (CONFLICT-1): the discriminator is an explicit param annotation, not arrow-vs-named.
describe("M81 section 5: forwardRef contextual typing (CONFLICT-1)", () => {
  it("Fixture A (radix shape): explicit parameter annotation extracts required/optional flags exactly", async () => {
    const schemas = await extractProps(fixture("forwardref-annotated.tsx"));
    expect(requiredMap(schemas)).toEqual(EXPECTED);
  });

  it("Fixture B (excalidraw shape): destructured arrow, unannotated, contextual typing only", async () => {
    const schemas = await extractProps(fixture("forwardref-destructured.tsx"));
    expect(requiredMap(schemas)).toEqual(EXPECTED);
  });

  it("Fixture C: named function expression, destructured, unannotated — isolates the true variable", async () => {
    const schemas = await extractProps(fixture("forwardref-named-destructured.tsx"));
    expect(requiredMap(schemas)).toEqual(EXPECTED);
  });

  it("radix's corroborating shape (Fixture A) is not regressed by any fix aimed at Fixture B", async () => {
    // forward-ref.tsx (H1 fixture) is Fixture-B-shaped: arrow, destructured, unannotated.
    const schemas = await extractProps("./fixtures/forward-ref.tsx");
    const names = schemas.map((s) => s.name).sort();
    expect(names).toEqual(["disabled", "placeholder", "size"]);
  });
});
