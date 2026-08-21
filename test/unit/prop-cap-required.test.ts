import { describe, it, expect, vi, afterEach } from "vitest";
import path from "node:path";
import { extractProps, resetExtractionCache } from "../../src/prop-gen.js";

const M86 = path.resolve("./fixtures/m86");
const fixture = (name: string): string => path.join(M86, name);

function captureStderr(): { lines: () => string[] } {
  resetExtractionCache();
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return { lines: () => write.mock.calls.map((c) => String(c[0])) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// M86 MUST: a required prop is never dropped by the cap.
describe("M86: required props bypass the cap", () => {
  it("config (required) survives even with >32 competing DOM props", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("required-and-referenced.tsx"));
    const config = schemas.find((s) => s.name === "config");
    expect(config).toBeDefined();
    expect(config?.required).toBe(true);
  });

  it("the cap warning names the true uncapped total", async () => {
    const stderr = captureStderr();
    await extractProps(fixture("required-and-referenced.tsx"));
    const warning = stderr.lines().find((l) => l.includes("props were extracted"));
    expect(warning).toBeDefined();
    const match = warning?.match(/(\d+) props were extracted/);
    expect(Number(match?.[1])).toBeGreaterThan(32);
  });
});

// M86 MUST: a prop the component's own source references by name outranks
// an inherited prop it does not.
describe("M86: source-referenced props outrank Tier-3 inherited volume", () => {
  it("onClick survives because the component body references props.onClick", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("required-and-referenced.tsx"));
    const names = schemas.map((s) => s.name);
    expect(names).toContain("onClick");
    expect(schemas.length).toBeLessThanOrEqual(32);
  });
});
