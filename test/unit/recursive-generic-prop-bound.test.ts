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

// M81 section 6 (element-plus-F1): unguarded recursion into a self-referential generic type.
describe("M81 section 6: self-referential generic types degrade honestly, never crash raw", () => {
  it("a TableProps<Node<T>>-shaped self-referential generic does not throw", async () => {
    const stderr = captureStderr();
    const schemas = await extractProps(fixture("recursive-generic-table.tsx"));
    expect(Array.isArray(schemas)).toBe(true);
    expect(stderr.lines().join("\n")).not.toMatch(/RangeError|Maximum call stack size exceeded/);
  });

  it("a self-widening generic (Wrap<T> = { value: T; next?: Wrap<Wrap<T>> }) does not throw", async () => {
    const stderr = captureStderr();
    const schemas = await extractProps(fixture("recursive-generic-selfwiden.tsx"));
    expect(Array.isArray(schemas)).toBe(true);
    expect(stderr.lines().join("\n")).not.toMatch(/RangeError|Maximum call stack size exceeded/);
  });

  it("recursive-generic-table.tsx extracts a schema array (not undefined, not a crash)", async () => {
    const schemas = await extractProps(fixture("recursive-generic-table.tsx"));
    expect(Array.isArray(schemas)).toBe(true);
  });
});
