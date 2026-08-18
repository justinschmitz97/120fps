import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  extractProps,
  extractAllProps,
  resetExtractionCache,
  extractionCacheStats,
} from "../../src/prop-gen.js";

beforeEach(() => {
  resetExtractionCache();
});

describe("extraction program cache", () => {
  it("returns identical schemas on cached and fresh calls", async () => {
    const fresh = await extractProps("./fixtures/button.tsx");
    const cached = await extractProps("./fixtures/button.tsx");
    expect(cached).toEqual(fresh);
    expect(extractionCacheStats().programsCreated).toBe(2);
  });

  it("parses the lib/type graph once across two components of one project", async () => {
    await extractProps("./fixtures/button.tsx");
    const afterFirst = extractionCacheStats().sourceFilesParsed;
    await extractProps("./fixtures/enum-prop.tsx");
    const afterSecond = extractionCacheStats().sourceFilesParsed;
    // The second component adds its own file and at most a handful of new
    // imports: not the lib + node_modules graph again.
    expect(afterFirst).toBeGreaterThan(20);
    expect(afterSecond - afterFirst).toBeLessThan(afterFirst / 10);
  });

  it("extractAllProps shares the chain with extractProps", async () => {
    await extractProps("./fixtures/two-exports.tsx");
    const afterProps = extractionCacheStats().sourceFilesParsed;
    const all = await extractAllProps("./fixtures/two-exports.tsx");
    const afterAll = extractionCacheStats().sourceFilesParsed;
    expect(all.size).toBeGreaterThan(0);
    expect(afterAll - afterProps).toBeLessThan(afterProps / 10);
  });

  it("re-parses a file whose content changed between calls", async () => {
    const tmp = path.resolve("./fixtures/.m36-tmp.tsx");
    fs.writeFileSync(
      tmp,
      `export function Tmp({ a }: { a: boolean }) { return <div>{String(a)}</div>; }`,
    );
    try {
      const first = await extractProps(tmp);
      expect(first.map((s) => s.name)).toEqual(["a"]);

      fs.writeFileSync(
        tmp,
        `export function Tmp({ b }: { b: string }) { return <div>{b}</div>; }`,
      );
      // Coarse filesystem timestamps must not mask the edit.
      const future = new Date(Date.now() + 5000);
      fs.utimesSync(tmp, future, future);

      const second = await extractProps(tmp);
      expect(second.map((s) => s.name)).toEqual(["b"]);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it("reset clears the cache and stats", async () => {
    await extractProps("./fixtures/button.tsx");
    resetExtractionCache();
    expect(extractionCacheStats()).toEqual({ programsCreated: 0, sourceFilesParsed: 0 });
    const schemas = await extractProps("./fixtures/button.tsx");
    expect(schemas.length).toBeGreaterThan(0);
  });
});
