import { describe, it, expect } from "vitest";
import path from "node:path";
import { extractProps } from "../../src/prop-gen.js";
import type { PropSchema } from "../../src/prop-gen.js";

const M81 = path.resolve("./fixtures/m81");
const fixture = (name: string): string => path.join(M81, name);

const requiredMap = (schemas: PropSchema[]): Record<string, boolean> =>
  Object.fromEntries(schemas.map((s) => [s.name, s.required]));

const EXPECTED = { id: true, label: false, count: false, active: false };

// M81 section 5 / CONFLICT-1, resolved: radix-primitives-F3 (accurate) and
// excalidraw-F4 (confidently wrong) are both forwardRef components; the
// discriminator is whether the callback's first parameter carries an
// explicit type annotation, not arrow-vs-named-function-expression syntax.
// These three fixtures settle the hypothesis rather than assume it.
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
    // forward-ref.tsx is the pre-existing H1 fixture, itself Fixture-B-shaped
    // (arrow, destructured, unannotated) with defaults on every field.
    const schemas = await extractProps("./fixtures/forward-ref.tsx");
    const names = schemas.map((s) => s.name).sort();
    expect(names).toEqual(["disabled", "placeholder", "size"]);
  });
});
