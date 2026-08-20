import { describe, it, expect, vi, afterEach } from "vitest";
import path from "node:path";
import { extractProps, resetExtractionCache } from "../../src/prop-gen.js";

const M81 = path.resolve("./fixtures/m81");
const fixture = (name: string): string => path.join(M81, name);

function captureStderr(): { lines: () => string[] } {
  resetExtractionCache();
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return { lines: () => write.mock.calls.map((c) => String(c[0])) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// M81 section 1: heroui-F1. Zero-declaration `variant`/`size` (reached
// through VariantProps<typeof x>, itself computed from a mapped type) must
// rank ahead of ~35 declared-in-node_modules passthrough props from a
// third-party (non-react-types) package, surviving the 32-prop cap.
describe("M81 section 1: cap ordering ranks zero-declaration variant props ahead of node_modules passthrough", () => {
  it("variant and size survive the 32-prop cap", async () => {
    const stderr = captureStderr();
    const schemas = await extractProps(fixture("heroui-button-cap.tsx"));
    const names = schemas.map((s) => s.name);

    expect(schemas.length).toBe(32);
    expect(names).toContain("variant");
    expect(names).toContain("size");

    const warning = stderr.lines().find((l) => l.includes("props were extracted"));
    expect(warning).toBeDefined();
    // 35 AriaButtonProps members + variant + size = 37 true total.
    expect(warning).toContain("37 props were extracted");
  });

  it("variant classifies as a union (Tier 1: literal union on its own type)", async () => {
    const schemas = await extractProps(fixture("heroui-button-cap.tsx"));
    const variant = schemas.find((s) => s.name === "variant");
    expect(variant?.kind).toBe("union");
    expect(variant?.values).toEqual(["solid", "bordered", "light"]);
  });
});

// Positive control: a prop already `declaredHere: true` today (locally
// re-declared indexed access) must be unaffected by the tier-rank change.
describe("M81 section 1: positive control is unaffected by the rank change", () => {
  it("a locally re-declared indexed-access variant prop is still extracted", async () => {
    const schemas = await extractProps(fixture("table-indexed-variant.tsx"));
    const names = schemas.map((s) => s.name).sort();
    expect(names).toEqual(["rows", "variant"]);
    const variant = schemas.find((s) => s.name === "variant");
    expect(variant?.kind).toBe("union");
    expect(variant?.values).toEqual(["default", "striped", "bordered"]);
  });
});

// M81 sections 1+2 interaction: the ant-design cap-ordering fix. Once the
// noise filter (section 2) stops deleting the DOM surface, the cap has real
// work to do and must fire an honest, uncapped total naming the true count —
// not the artificially low pre-filter count. This is the SEPARATE fix from
// the noise-filter-only test in prop-inheritance-disclosure.test.ts: this one
// is about the cap/ranking mechanism correctly absorbing the larger `kept`
// set, not about the filter itself.
describe("M81 cap ordering + noise-filter interaction: ant-design's Button", () => {
  it("onClick and disabled survive the cap and warnPropCap names the true total", async () => {
    const stderr = captureStderr();
    const schemas = await extractProps(fixture("antd-button-cap.tsx"));
    const names = schemas.map((s) => s.name);

    expect(schemas.length).toBe(32);
    expect(names).toContain("onClick");
    expect(names).toContain("disabled");

    const warning = stderr.lines().find((l) => l.includes("props were extracted"));
    expect(warning).toBeDefined();
    const match = warning?.match(/(\d+) props were extracted/);
    expect(match).toBeTruthy();
    const total = Number(match?.[1]);
    // 42 real @types/react-declared members (Pick-preserved, so still
    // attributed to node_modules/@types/react) in this fixture. A total at or
    // under 32 here would mean the noise filter is still silently dropping
    // some of the surface before the cap ever counts it.
    expect(total).toBe(42);
  });
});
