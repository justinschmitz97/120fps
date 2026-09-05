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

// ant-design-F3: fixture stays under the cap; survival here proves the filter changed, not ranking.
describe("M81 section 2: noise filter stops deleting real component surface", () => {
  it("onClick and children survive extraction with no cap ever in play", async () => {
    const stderr = captureStderr();
    const schemas = await extractProps(fixture("antd-tag-small.tsx"));
    const names = schemas.map((s) => s.name).sort();

    expect(names).toEqual(["children", "className", "closable", "color", "onClick"]);
    expect(stderr.lines().some((l) => l.includes("props were extracted"))).toBe(false);
  });

  it("onClick is classified as a function prop", async () => {
    const schemas = await extractProps(fixture("antd-tag-small.tsx"));
    expect(schemas.find((s) => s.name === "onClick")?.kind).toBe("function");
  });

  it("children is classified as reactnode", async () => {
    const schemas = await extractProps(fixture("antd-tag-small.tsx"));
    expect(schemas.find((s) => s.name === "children")?.kind).toBe("reactnode");
  });
});

describe("M81 does not include: aria-*/data-* stay a hard, silent, pre-cap filter", () => {
  it("an aria-* prop is still removed even when declared locally", async () => {
    const schemas = await extractProps(fixture("aria-noise-local.tsx"));
    const names = schemas.map((s) => s.name);
    expect(names).not.toContain("aria-describedby");
    expect(names).toContain("label");
  });
});
