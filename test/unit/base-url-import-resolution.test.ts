import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadTsconfigAliases } from "../../src/harness.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mkProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-baseurl-"));
  cleanupDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

const fwd = (p: string) => p.replace(/\\/g, "/");

function resolveWith(
  aliases: Array<{ find: RegExp; replacement: string }>,
  specifier: string,
): string | undefined {
  for (const { find, replacement } of aliases) {
    if (find.test(specifier)) return specifier.replace(find, replacement);
  }
  return undefined;
}

// baseUrl without paths is the CRA shape: `import Button from "components/Button"`
// is resolved against baseUrl by tsc and by every bundler the project has ever
// used, so the harness has to resolve it too.
describe("bare imports resolved against baseUrl", () => {
  const project = () =>
    mkProject({
      "package.json": JSON.stringify({ name: "cra-app", dependencies: { react: "^18.0.0" } }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "./src" } }),
      "src/components/Button.tsx": "export function Button() { return null; }\n",
      "src/utils.ts": "export const noop = () => {};\n",
      "src/react/README.md": "not the npm package\n",
    });

  it("resolves a subpath under a baseUrl directory", () => {
    const dir = project();
    const aliases = loadTsconfigAliases(dir);
    expect(resolveWith(aliases, "components/Button")).toBe(`${fwd(dir)}/src/components/Button`);
  });

  it("resolves the directory name on its own", () => {
    const dir = project();
    const aliases = loadTsconfigAliases(dir);
    expect(resolveWith(aliases, "components")).toBe(`${fwd(dir)}/src/components`);
  });

  it("resolves a source file by its stem", () => {
    const dir = project();
    const aliases = loadTsconfigAliases(dir);
    expect(resolveWith(aliases, "utils")).toBe(`${fwd(dir)}/src/utils.ts`);
  });

  it("leaves a declared npm package to node resolution", () => {
    const dir = project();
    const aliases = loadTsconfigAliases(dir);
    expect(resolveWith(aliases, "react")).toBeUndefined();
    expect(resolveWith(aliases, "react-dom/client")).toBeUndefined();
  });

  it("leaves an installed but undeclared package to node resolution", () => {
    const dir = mkProject({
      "package.json": JSON.stringify({ name: "app" }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "." } }),
      "node_modules/clsx/package.json": JSON.stringify({ name: "clsx" }),
      "clsx/index.ts": "export default null;\n",
    });
    expect(resolveWith(loadTsconfigAliases(dir), "clsx")).toBeUndefined();
  });

  it("does not alias a specifier with no matching entry under baseUrl", () => {
    const dir = project();
    expect(resolveWith(loadTsconfigAliases(dir), "lodash-es")).toBeUndefined();
  });

  it("ignores node_modules and dotted entries under baseUrl", () => {
    const dir = mkProject({
      "package.json": JSON.stringify({ name: "app" }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "." } }),
      "node_modules/left-pad/index.js": "module.exports = null;\n",
      ".cache/x.ts": "export const x = 1;\n",
      "lib/x.ts": "export const x = 1;\n",
    });
    const aliases = loadTsconfigAliases(dir);
    expect(resolveWith(aliases, "node_modules")).toBeUndefined();
    expect(resolveWith(aliases, ".cache")).toBeUndefined();
    expect(resolveWith(aliases, "lib/x")).toBe(`${fwd(dir)}/lib/x`);
  });

  it("keeps returning no aliases when neither baseUrl nor paths is set", () => {
    const dir = mkProject({
      "package.json": JSON.stringify({ name: "app" }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
      "src/x.ts": "export const x = 1;\n",
    });
    expect(loadTsconfigAliases(dir)).toEqual([]);
  });

  it("declared paths keep priority over the baseUrl fallback", () => {
    const dir = mkProject({
      "package.json": JSON.stringify({ name: "app" }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: "./src", paths: { "@/*": ["./lib/*"] } },
      }),
      "src/components/Button.tsx": "export function Button() { return null; }\n",
      "src/lib/x.ts": "export const x = 1;\n",
    });
    const aliases = loadTsconfigAliases(dir);
    // paths present: this milestone leaves bare baseUrl specifiers alone.
    expect(aliases).toHaveLength(1);
    expect(resolveWith(aliases, "@/x")).toBe(`${fwd(dir)}/src/lib/x`);
  });
});
