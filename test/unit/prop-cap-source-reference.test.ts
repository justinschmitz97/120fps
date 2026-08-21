import { describe, it, expect } from "vitest";
import path from "node:path";
import { extractProps, resetExtractionCache } from "../../src/prop-gen.js";

const M86 = path.resolve("./fixtures/m86");
const fixture = (name: string): string => path.join(M86, name);

// M86 MUST: a handler prop ranks as a handler even when its type flows
// through an unresolved generic parameter (polymorphic-element pattern).
describe("M86: polymorphic generic component's onClick ranks ahead of Tier-3 volume", () => {
  it("onClick survives the cap on TableRootProps<E>", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("polymorphic-handler.tsx"));
    const names = schemas.map((s) => s.name);
    expect(names).toContain("onClick");
    expect(names).toContain("variant");
  });
});

// M92 (ant-design Button.tsx:294, M86's own motivating case): `const Button =
// InternalButton as CompoundedButton` -- an AsExpression wrapping a bare
// Identifier -- previously defeated both extractFunctionFromInitializer and
// identifierBehind, so Tier-0's source-reference scan never saw
// InternalButton's own `props.onClick` reference and onClick fell to Tier-3
// DOM-event volume exactly like ant-design's real Button/Tag.
describe("M92: an `as`-expression alias still promotes onClick via Tier 0", () => {
  it("onClick survives the cap through the AsExpression + identifier alias", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("as-expression-alias.tsx"));
    const names = schemas.map((s) => s.name);
    expect(names).toContain("onClick");
  });
});
