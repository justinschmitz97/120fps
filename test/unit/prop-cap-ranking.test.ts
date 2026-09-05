import { describe, it, expect, vi, afterEach } from "vitest";
import path from "node:path";
import { extractProps, resetExtractionCache } from "../../src/props/index.js";

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

// heroui-F1 (M81): variant/size are zero-declaration, reached via VariantProps<typeof x>.
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

// Positive control: this variant is already declaredHere via a re-declared indexed access.
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

// Not the filter-only test in prop-inheritance-disclosure.test.ts: cap must report the true total.
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
    // 42 real @types/react members; <=32 would mean the noise filter hid surface before the cap.
    expect(total).toBe(42);
  });
});
