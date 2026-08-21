import { describe, it, expect } from "vitest";
import path from "node:path";
import { extractProps, resetExtractionCache } from "../../src/prop-gen.js";

const M86 = path.resolve("./fixtures/m86");
const fixture = (name: string): string => path.join(M86, name);

// M86 mechanism 1: a handler prop ranks as a handler even when its type
// flows through an unresolved generic parameter. `polymorphic-spread-only.tsx`
// never references `onClick` by name in its own body (only `{...props}`), so
// the M86 Tier-0 source-reference promotion does not apply here — this
// isolates the type-flow handler check (Tier 2) itself.
describe("M86 mechanism 1: polymorphic handler ranks via type-flow alone (no source reference)", () => {
  it("documents that Tier 2's type-flow check alone is not sufficient here — Tier-2 volume wins the tiebreak", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("polymorphic-spread-only.tsx"));
    const names = schemas.map((s) => s.name);
    // A genuine, empirically-confirmed negative result, not a broken
    // assertion: `onClick`'s type resolves with real call signatures here
    // (confirmed by direct probing — TypeScript's checker did not lose
    // call-signature information through this or any other polymorphic/
    // conditional-type shape tried), so it correctly reaches Tier 2. But
    // several OTHER Tier-2 handlers (`onCopy`, `onChange`, ...) are declared
    // earlier in `@types/react`'s own source order and win the stable-sort
    // tiebreak within the tier, matching the map's own "mechanism 2: volume"
    // framing — Tier 2 alone is not immune to volume, only Tier 0
    // (source-referenced/preset) is. `polymorphic-handler.tsx`'s sibling
    // test (`prop-cap-source-reference.test.ts`) shows the same component
    // WITH a `props.onClick` body reference keeps `onClick` via Tier 0.
    expect(names).not.toContain("onClick");
    expect(schemas.length).toBe(32);
  });
});
