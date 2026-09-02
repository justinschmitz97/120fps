import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TAILWIND_CONFIG_FILES,
  resolveStyleTooling,
  resolveTailwind3Config,
} from "../../src/harness.js";
import { resolveGoverningTsconfig } from "../../src/project-model.js";

const FIXTURE_ROOT = path.resolve(__dirname, "..", "..", "fixtures", "tailwind3-monorepo");
const FIXTURE_MEMBER = path.join(FIXTURE_ROOT, "packages", "ui");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-tw3-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(file: string, content: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function workspace(memberFiles: Record<string, string>, rootFiles: Record<string, string> = {}): {
  root: string;
  member: string;
} {
  const root = path.join(tmpDir, "repo");
  const member = path.join(root, "packages", "ui");
  write(path.join(root, "package.json"), JSON.stringify({ name: "repo", private: true }));
  write(path.join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  for (const [rel, content] of Object.entries(rootFiles)) write(path.join(root, rel), content);
  for (const [rel, content] of Object.entries(memberFiles)) write(path.join(member, rel), content);
  return { root, member };
}

const TAILWIND3_MEMBER = {
  "package.json": JSON.stringify({ name: "ui", devDependencies: { tailwindcss: "^3.4.19" } }),
  "postcss.config.js": "module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };\n",
};

describe("the Tailwind 3 config a member builds with", () => {
  it("is the one nearest the member, whatever directory the run started in", () => {
    const fromRepoRoot = resolveStyleTooling(FIXTURE_MEMBER, FIXTURE_ROOT, [], FIXTURE_ROOT);
    const fromMember = resolveStyleTooling(FIXTURE_MEMBER, FIXTURE_ROOT, [], FIXTURE_MEMBER);
    expect(fromRepoRoot.tailwind3ConfigPath).toBe(path.join(FIXTURE_MEMBER, "tailwind.config.js"));
    expect(fromMember.tailwind3ConfigPath).toBe(fromRepoRoot.tailwind3ConfigPath);
  });

  it("comes from an ancestor when the member declares none of its own", () => {
    const { root, member } = workspace(TAILWIND3_MEMBER, {
      "tailwind.config.ts": "export default { content: [] };\n",
    });
    expect(resolveTailwind3Config(member, root)?.configPath).toBe(
      path.join(root, "tailwind.config.ts"),
    );
  });

  it("is not computed for a member on the Tailwind 4 Vite plugin", () => {
    const { root, member } = workspace({
      "package.json": JSON.stringify({ name: "ui", devDependencies: { tailwindcss: "^4.0.0" } }),
      "postcss.config.js": "module.exports = { plugins: { tailwindcss: {} } };\n",
      "tailwind.config.js": "module.exports = { content: [] };\n",
    });
    write(
      path.join(member, "node_modules", "@tailwindcss", "vite", "package.json"),
      JSON.stringify({ name: "@tailwindcss/vite", version: "4.0.0" }),
    );
    const tooling = resolveStyleTooling(member, root, [], root);
    expect(tooling.tailwind).toBe(true);
    expect(tooling.tailwind3ConfigPath).toBeUndefined();
  });
});

describe("two runs of one component that differ only in the shell directory", () => {
  it("resolve the same style tooling", () => {
    expect(resolveStyleTooling(FIXTURE_MEMBER, FIXTURE_ROOT, [], FIXTURE_ROOT)).toEqual(
      resolveStyleTooling(FIXTURE_MEMBER, FIXTURE_ROOT, [], FIXTURE_MEMBER),
    );
  });

  it("resolve the same governing tsconfig, an absolute path with no directory input", () => {
    const { root, member } = workspace({
      ...TAILWIND3_MEMBER,
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
    });
    const governing = resolveGoverningTsconfig(path.join(member, "src", "Button.tsx"), root);
    expect(governing.configPath).toBe(path.join(member, "tsconfig.json").replace(/\\/g, "/"));
    expect(path.isAbsolute(governing.configPath!)).toBe(true);
  });
});

describe("a Tailwind 3 pipeline with no config at any level", () => {
  it("names the filenames, the directories searched and the directory the run started in", () => {
    const { root, member } = workspace(TAILWIND3_MEMBER);
    const startDir = path.join(root, "apps", "web");
    const warning = resolveStyleTooling(member, root, [], startDir).warnings.join("\n");
    for (const name of TAILWIND_CONFIG_FILES) expect(warning).toContain(name);
    expect(warning).toContain(member);
    expect(warning).toContain(root);
    expect(warning).toContain(startDir);
    expect(warning).not.toMatch(/pnpm run|npm run|yarn /);
  });
});
