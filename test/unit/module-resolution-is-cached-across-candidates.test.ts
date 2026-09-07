import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import {
  resetCompilerOptionsCache,
  resetModuleResolutionCache,
  resetTsconfigAliasTables,
  resetTsconfigReadCache,
  resetWorkspaceSourceCache,
  runPreflight,
} from "../../src/project/index.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetModuleResolutionCache();
  resetCompilerOptionsCache();
  resetTsconfigAliasTables();
  resetTsconfigReadCache();
  resetWorkspaceSourceCache();
  vi.restoreAllMocks();
});

// Three candidates in one invocation walk one graph, so they ask the same questions three times.
function projectWithThreeCandidates(prefix: string): { root: string; candidates: string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(root);
  const write = (rel: string, content: string): string => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  };
  write("package.json", JSON.stringify({ name: "app", dependencies: { react: "18.3.1" } }));
  write(
    "tsconfig.json",
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }),
  );
  write("src/shared/one.ts", 'import { two } from "@/shared/two";\nexport const one = two;\n');
  write("src/shared/two.ts", "export const two = 2;\n");
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  const candidates = ["A", "B", "C"].map((name) =>
    write(
      `src/components/${name}.tsx`,
      `import { one } from "@/shared/one";\nexport function ${name}() { return null; }\nexport const shown = one;\n`,
    ),
  );
  return { root, candidates };
}

function countHostLookups(run: () => void): number {
  const spy = vi.spyOn(ts.sys, "fileExists");
  try {
    run();
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
}

describe("the module resolutions one dry run performs", () => {
  it("are not repeated for the second and third candidate", () => {
    const { root, candidates } = projectWithThreeCandidates("120fps-resolution-cache-");

    const first = countHostLookups(() => {
      runPreflight({ projectRoot: root, entries: [candidates[0]] });
    });
    const later = countHostLookups(() => {
      runPreflight({ projectRoot: root, entries: [candidates[1]] });
      runPreflight({ projectRoot: root, entries: [candidates[2]] });
    });

    expect(first).toBeGreaterThan(0);
    expect(later).toBe(0);
  });

  it("answer exactly what an uncached walk answered", () => {
    const { root, candidates } = projectWithThreeCandidates("120fps-resolution-cache-equal-");

    const cold = runPreflight({ projectRoot: root, entries: [candidates[0]] });
    const warm = runPreflight({ projectRoot: root, entries: [candidates[0]] });
    resetModuleResolutionCache();
    const again = runPreflight({ projectRoot: root, entries: [candidates[0]] });

    expect(warm).toEqual(cold);
    expect(again).toEqual(cold);
  });

  it("are not shared between two projects with different compiler options", () => {
    const first = projectWithThreeCandidates("120fps-resolution-cache-a-");
    const second = projectWithThreeCandidates("120fps-resolution-cache-b-");

    countHostLookups(() => {
      runPreflight({ projectRoot: first.root, entries: [first.candidates[0]] });
    });
    const other = countHostLookups(() => {
      runPreflight({ projectRoot: second.root, entries: [second.candidates[0]] });
    });

    expect(other).toBeGreaterThan(0);
  });
});
