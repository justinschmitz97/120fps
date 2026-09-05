import { describe, it, expect } from "vitest";
import path from "node:path";
import { extractProps, resetExtractionCache } from "../../src/props/index.js";

const M86 = path.resolve("./fixtures/m86");
const fixture = (name: string): string => path.join(M86, name);

// M86: polymorphic-spread-only.tsx never names onClick, so Tier-0 skips; isolates Tier-2 ranking.
describe("M86 mechanism 1: polymorphic handler ranks via type-flow alone (no source reference)", () => {
  it("documents that Tier 2's type-flow check alone is not sufficient here — Tier-2 volume wins the tiebreak", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("polymorphic-spread-only.tsx"));
    const names = schemas.map((s) => s.name);
    // Intentional: onClick reaches Tier 2 but loses the volume tiebreak to earlier handlers.
    expect(names).not.toContain("onClick");
    expect(schemas.length).toBe(32);
  });
});
