import { describe, it, expect } from "vitest";
import path from "node:path";
import { extractProps, resetExtractionCache } from "../../src/props/index.js";

const M86 = path.resolve("./fixtures/m86");
const fixture = (name: string): string => path.join(M86, name);

describe("M86: polymorphic generic component's onClick ranks ahead of Tier-3 volume", () => {
  it("onClick survives the cap on TableRootProps<E>", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("polymorphic-handler.tsx"));
    const names = schemas.map((s) => s.name);
    expect(names).toContain("onClick");
    expect(names).toContain("variant");
  });
});

// M92 (ant-design Button.tsx:294): AsExpression-wrapped identifier alias must resolve onClick.
describe("M92: an `as`-expression alias still promotes onClick via Tier 0", () => {
  it("onClick survives the cap through the AsExpression + identifier alias", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("as-expression-alias.tsx"));
    const names = schemas.map((s) => s.name);
    expect(names).toContain("onClick");
  });
});
