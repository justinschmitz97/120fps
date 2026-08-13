import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { computeSourceFingerprint } from "../../src/budget.js";
import { projectSourceFiles } from "../../src/prop-gen.js";

const ROOT = path.resolve(".");

describe("M39: computeSourceFingerprint", () => {
  it("is deterministic and order-independent", () => {
    const a = computeSourceFingerprint(ROOT, ["fixtures/button.tsx", "fixtures/helpers.ts"], "cfg");
    const b = computeSourceFingerprint(ROOT, ["fixtures/helpers.ts", "fixtures/button.tsx"], "cfg");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });

  it("changes when file content changes", () => {
    const tmp = path.resolve("fixtures/.m39-tmp.txt");
    fs.writeFileSync(tmp, "one");
    try {
      const a = computeSourceFingerprint(ROOT, [tmp], "cfg");
      fs.writeFileSync(tmp, "two");
      const b = computeSourceFingerprint(ROOT, [tmp], "cfg");
      expect(a).not.toBe(b);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it("changes when the config string changes", () => {
    const a = computeSourceFingerprint(ROOT, ["fixtures/button.tsx"], "cfg-a");
    const b = computeSourceFingerprint(ROOT, ["fixtures/button.tsx"], "cfg-b");
    expect(a).not.toBe(b);
  });

  it("treats a missing file as part of the identity, not an error", () => {
    const a = computeSourceFingerprint(ROOT, ["fixtures/does-not-exist.tsx"], "cfg");
    const b = computeSourceFingerprint(ROOT, ["fixtures/button.tsx"], "cfg");
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    expect(a).not.toBe(b);
  });
});

describe("M39: projectSourceFiles", () => {
  it("returns the component and its local imports, never libs or node_modules", async () => {
    const files = await projectSourceFiles("./fixtures/with-import.tsx");
    const names = files.map((f) => path.basename(f));
    expect(names).toContain("with-import.tsx");
    expect(names).toContain("helpers.ts");
    expect(files.some((f) => /node_modules/.test(f))).toBe(false);
    expect(files.some((f) => /[\\/]lib\.[^\\/]*\.d\.ts$/.test(f))).toBe(false);
  });
});
