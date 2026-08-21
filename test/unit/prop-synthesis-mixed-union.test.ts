import { describe, it, expect, vi, afterEach } from "vitest";
import path from "node:path";
import { extractProps, resetExtractionCache } from "../../src/prop-gen.js";

const M84 = path.resolve("./fixtures/m84");
const fixture = (name: string): string => path.join(M84, name);

function captureStderr(): { lines: () => string[] } {
  resetExtractionCache();
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return { lines: () => write.mock.calls.map((c) => String(c[0])) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// M84 MUST: a mixed primitive-and-literal union synthesizes a member of that
// union, not kind:"unknown" with an empty value and zero disclosure.
describe("M84: mixed primitive+literal unions synthesize a real member", () => {
  it("modal (boolean | 'trap-focus') is not dropped to kind:unknown", async () => {
    const stderr = captureStderr();
    const schemas = await extractProps(fixture("mixed-union.tsx"));
    const modal = schemas.find((s) => s.name === "modal");
    expect(modal).toBeDefined();
    expect(modal?.kind).not.toBe("unknown");
    expect(modal?.values.length).toBeGreaterThan(0);

    const step = schemas.find((s) => s.name === "step");
    expect(step).toBeDefined();
    expect(step?.kind).not.toBe("unknown");
    expect(step?.values.length).toBeGreaterThan(0);

    // MUST: reports every branch it collapsed, and which branch it chose.
    const warning = stderr.lines().find((l) => l.includes('"modal"') && l.includes("union"));
    expect(warning).toBeDefined();
    // TS prints `boolean` decomposed as its two literal members.
    expect(warning).toContain("true");
    expect(warning).toContain("trap-focus");
  });

  it("step (number | 'any') is not silently dropped", async () => {
    const stderr = captureStderr();
    await extractProps(fixture("mixed-union.tsx"));
    const warning = stderr.lines().find((l) => l.includes('"step"') && l.includes("union"));
    expect(warning).toBeDefined();
    expect(warning).toContain("number");
    expect(warning).toContain("any");
  });
});

// M84 MUST NOT: silently drop a prop from synthesis (base-ui's modal/step
// were dropped with zero warning).
describe("M84 MUST NOT: mixed-union props are never silently dropped", () => {
  it("both modal and step are present in the extracted schema", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("mixed-union.tsx"));
    const names = schemas.map((s) => s.name);
    expect(names).toContain("modal");
    expect(names).toContain("step");
  });
});

// M84 MUST: a multi-branch union (structurally different shapes, not merely
// mixed primitive+literal) reports every branch it collapsed and which one
// it chose.
describe("M84: multi-branch unions disclose every collapsed branch", () => {
  it("label (string | ReactElement) discloses both branches", async () => {
    const stderr = captureStderr();
    const schemas = await extractProps(fixture("multi-branch-union.tsx"));
    const label = schemas.find((s) => s.name === "label");
    expect(label).toBeDefined();

    const warning = stderr.lines().find((l) => l.includes('"label"') && l.includes("union"));
    expect(warning).toBeDefined();
  });

  it("content ((() => ReactNode) | ReactNode | null) discloses its collapsed branches", async () => {
    const stderr = captureStderr();
    await extractProps(fixture("multi-branch-union.tsx"));
    const warning = stderr.lines().find((l) => l.includes('"content"') && l.includes("union"));
    expect(warning).toBeDefined();
  });
});
