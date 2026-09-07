import { describe, it, expect, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectStaticPreBuildWarnings,
  resetPreBuildDisclosures,
} from "../../src/harness/index.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetPreBuildDisclosures();
});

// One --explain-props invocation walks several candidates over one graph and one shared barrel.
function projectWithSharedBarrel(prefix: string): { root: string; candidates: string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(root);
  const write = (rel: string, content: string): string => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  };
  write("package.json", JSON.stringify({ name: "app" }));
  write("src/barrel.ts", 'import "absent-package";\nexport const barrel = 1;\n');
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  const candidates = ["A", "B", "C"].map((name) =>
    write(
      `src/${name}.tsx`,
      `import { barrel } from "./barrel";\nexport function ${name}() { return null; }\nexport const shown = barrel;\n`,
    ),
  );
  return { root, candidates };
}

const unresolvedLines = (warnings: string[]): string[] =>
  warnings.filter((warning) => warning.includes("resolves to no installed package"));

describe("a package that resolves nowhere", () => {
  it("is disclosed once for the whole run, not once per candidate", () => {
    const { root, candidates } = projectWithSharedBarrel("120fps-unresolved-once-");

    const reported = candidates.map(
      (candidate) =>
        unresolvedLines(collectStaticPreBuildWarnings(root, { componentPath: candidate }).warnings)
          .length,
    );

    expect(reported[0]).toBe(1);
    expect(reported.slice(1)).toEqual([0, 0]);
  });

  it("is disclosed again for a different project in the same process", () => {
    const first = projectWithSharedBarrel("120fps-unresolved-once-a-");
    const second = projectWithSharedBarrel("120fps-unresolved-once-b-");

    collectStaticPreBuildWarnings(first.root, { componentPath: first.candidates[0] });
    const other = collectStaticPreBuildWarnings(second.root, {
      componentPath: second.candidates[0],
    });

    expect(unresolvedLines(other.warnings)).toHaveLength(1);
  });
});
