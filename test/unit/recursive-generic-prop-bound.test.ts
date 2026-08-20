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

// M81 section 6: element-plus-F1. `typeToSchema`'s classification loop and
// `classifyType` call the TypeScript checker directly on a raw `ts.Type`
// with no recursion guard; a self-referential *generic* type can make a
// single checker call recurse arbitrarily deep inside TS's own instantiation
// machinery. Acceptance is the observable contract: extraction either
// produces a schema or a named degenerate warning, and no bare
// RangeError/"Maximum call stack size exceeded" text reaches the caller.
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
