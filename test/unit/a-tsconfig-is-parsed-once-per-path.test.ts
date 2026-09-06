import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import {
  loadTsconfigAliases,
  resetCompilerOptionsCache,
  resetModuleResolutionCache,
  resetTsconfigAliasTables,
  resetTsconfigReadCache,
  resetWorkspaceSourceCache,
  resolveGoverningTsconfig,
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

function makeProject(prefix: string, files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  return root;
}

const PLAIN = {
  "package.json": JSON.stringify({ name: "app" }),
  "tsconfig.json": JSON.stringify({
    compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
  }),
  "src/Card.tsx": "export function Card() { return null; }\n",
  "src/Other.tsx": "export function Other() { return null; }\n",
};

const REFERENCED = {
  "package.json": JSON.stringify({ name: "app" }),
  "tsconfig.json": JSON.stringify({
    references: [{ path: "./tsconfig.app.json" }, { path: "./tsconfig.node.json" }],
    files: [],
  }),
  "tsconfig.app.json": JSON.stringify({
    compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
    include: ["src"],
  }),
  "tsconfig.node.json": JSON.stringify({
    compilerOptions: { baseUrl: ".", paths: { "#/*": ["./tools/*"] } },
    include: ["tools"],
  }),
  "src/Card.tsx": "export function Card() { return null; }\n",
  "tools/build.ts": "export const build = 1;\n",
};

function countConfigReads(run: () => void): { reads: string[]; directories: number } {
  const reads: string[] = [];
  const realRead = ts.sys.readFile.bind(ts.sys);
  const readSpy = vi.spyOn(ts.sys, "readFile").mockImplementation((fileName, encoding) => {
    if (/tsconfig[^/\\]*\.json$/.test(fileName)) reads.push(path.resolve(fileName));
    return realRead(fileName, encoding);
  });
  const realReadDirectory = ts.sys.readDirectory.bind(ts.sys);
  const directorySpy = vi
    .spyOn(ts.sys, "readDirectory")
    .mockImplementation((...args: Parameters<typeof ts.sys.readDirectory>) =>
      realReadDirectory(...args),
    );
  try {
    run();
    return { reads, directories: directorySpy.mock.calls.length };
  } finally {
    readSpy.mockRestore();
    directorySpy.mockRestore();
  }
}

describe("the tsconfig a run reads", () => {
  it("is read once per absolute path however many callers ask", () => {
    const root = makeProject("120fps-tsconfig-once-", PLAIN);

    const { reads } = countConfigReads(() => {
      resolveGoverningTsconfig(path.join(root, "src", "Card.tsx"), root);
      resolveGoverningTsconfig(path.join(root, "src", "Other.tsx"), root);
      loadTsconfigAliases(root, undefined, path.join(root, "src", "Card.tsx"));
      loadTsconfigAliases(root, undefined, path.join(root, "src", "Other.tsx"));
    });

    const configPath = path.resolve(root, "tsconfig.json");
    expect(reads.filter((file) => file === configPath)).toHaveLength(1);
  });

  it("is parsed without expanding the include globs of the project", () => {
    const root = makeProject("120fps-tsconfig-no-globs-", PLAIN);

    const { directories } = countConfigReads(() => {
      resolveGoverningTsconfig(path.join(root, "src", "Card.tsx"), root);
      loadTsconfigAliases(root, undefined, path.join(root, "src", "Card.tsx"));
    });

    expect(directories).toBe(0);
  });

  it("expands its globs only where a referenced config has to be matched against the file", () => {
    const root = makeProject("120fps-tsconfig-references-", REFERENCED);

    const { directories } = countConfigReads(() => {
      resolveGoverningTsconfig(path.join(root, "src", "Card.tsx"), root);
    });

    expect(directories).toBeGreaterThan(0);
  });

  it("answers the same options and paths as an uncached read", () => {
    const root = makeProject("120fps-tsconfig-equal-", PLAIN);
    const file = path.join(root, "src", "Card.tsx");

    const cold = resolveGoverningTsconfig(file, root);
    const warm = resolveGoverningTsconfig(file, root);
    resetTsconfigReadCache();
    const again = resolveGoverningTsconfig(file, root);

    expect(warm.options.paths).toEqual(cold.options.paths);
    expect(warm.configPath).toBe(cold.configPath);
    expect(again.options.paths).toEqual(cold.options.paths);
    expect(again.base).toBe(cold.base);
  });

  it("selects the referenced config that covers the file, as before", () => {
    const root = makeProject("120fps-tsconfig-references-pick-", REFERENCED);

    const governing = resolveGoverningTsconfig(path.join(root, "src", "Card.tsx"), root);

    expect(governing.viaReferences).toBe(true);
    expect(governing.configPath).toContain("tsconfig.app.json");
    expect(Object.keys(governing.options.paths ?? {})).toEqual(["@/*"]);
  });
});
