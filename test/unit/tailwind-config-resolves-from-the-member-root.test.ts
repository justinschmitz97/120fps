import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  TAILWIND_CONFIG_FILES,
  loadTailwind3PostcssPipeline,
  resolveStyleTooling,
  resolveTailwind3Config,
  writeAnchoredTailwind3Config,
} from "../../src/harness/index.js";
import { resolveGoverningTsconfig } from "../../src/project/index.js";

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

const FAKE_TAILWIND_INDEX = 'module.exports = (options) => ({ postcssPlugin: "tailwindcss", options });\n';
const FAKE_LOAD_CONFIG = "module.exports = (file) => require(file);\n";
const FAKE_AUTOPREFIXER = 'module.exports = () => ({ postcssPlugin: "autoprefixer" });\n';

// Fakes, not this repo's v4 tailwindcss (no loadConfig): the assertion checks plugin identity only.
function tailwind3Member(files: Record<string, string>): string {
  const { member } = workspace({
    "package.json": JSON.stringify({ name: "ui", devDependencies: { tailwindcss: "^3.4.19" } }),
    "tailwind.config.js": 'module.exports = { content: ["./src/**/*.{ts,tsx}"] };\n',
    "node_modules/tailwindcss/package.json": JSON.stringify({
      name: "tailwindcss",
      version: "3.4.19",
      main: "index.js",
      exports: { ".": "./index.js", "./loadConfig": "./loadConfig.js" },
    }),
    "node_modules/tailwindcss/index.js": FAKE_TAILWIND_INDEX,
    "node_modules/tailwindcss/loadConfig.js": FAKE_LOAD_CONFIG,
    "node_modules/autoprefixer/package.json": JSON.stringify({
      name: "autoprefixer",
      version: "10.4.0",
      main: "index.js",
    }),
    "node_modules/autoprefixer/index.js": FAKE_AUTOPREFIXER,
    ...files,
  });
  return member;
}

function pluginNames(pipeline: { plugins: unknown[] } | undefined): (string | undefined)[] {
  return (pipeline?.plugins ?? []).map((p) => (p as { postcssPlugin?: string }).postcssPlugin);
}

describe("the PostCSS pipeline rebuilt with an explicit Tailwind 3 config", () => {
  it("keeps every plugin the member declared, in the order it declared them", async () => {
    const member = tailwind3Member({
      "postcss.config.js": "module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };\n",
    });
    const pipeline = await loadTailwind3PostcssPipeline(
      member,
      path.join(member, "postcss.config.js"),
      path.join(member, "tailwind.config.js"),
      member,
    );
    expect(pipeline?.plugins).toHaveLength(2);
    expect(pluginNames(pipeline)).toEqual(["tailwindcss", "autoprefixer"]);
  });

  it("drops a plugin the member disabled with `false`", async () => {
    const member = tailwind3Member({
      "postcss.config.js":
        "module.exports = { plugins: { tailwindcss: {}, autoprefixer: false } };\n",
    });
    const pipeline = await loadTailwind3PostcssPipeline(
      member,
      path.join(member, "postcss.config.js"),
      path.join(member, "tailwind.config.js"),
      member,
    );
    expect(pluginNames(pipeline)).toEqual(["tailwindcss"]);
  });

  it("keeps a config path the member pinned itself", async () => {
    const member = tailwind3Member({
      "postcss.config.js":
        'module.exports = { plugins: { tailwindcss: { config: "./tailwind.other.js" } } };\n',
    });
    const pipeline = await loadTailwind3PostcssPipeline(
      member,
      path.join(member, "postcss.config.js"),
      path.join(member, "tailwind.config.js"),
      member,
    );
    const options = (pipeline?.plugins[0] as { options?: { config?: string } }).options;
    expect(options?.config).toBe("./tailwind.other.js");
  });

  it("says so when it cannot read a plugin list, instead of falling back in silence", async () => {
    const member = tailwind3Member({
      "postcss.config.ts": "export default { plugins: { tailwindcss: {} } };\n",
    });
    const warnings: string[] = [];
    const configFile = path.join(member, "postcss.config.ts");
    const pipeline = await loadTailwind3PostcssPipeline(
      member,
      configFile,
      path.join(member, "tailwind.config.js"),
      member,
      (warning) => warnings.push(warning),
    );
    expect(pipeline).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(configFile);
    expect(warnings[0]).toContain("the directory this run started in");
  });
});

describe("the Tailwind 3 config the pipeline is given", () => {
  it("resolves the member's relative content globs against the member root", () => {
    const member = tailwind3Member({
      "postcss.config.js": "module.exports = { plugins: { tailwindcss: {} } };\n",
    });
    const generated = writeAnchoredTailwind3Config(
      member,
      path.join(member, "tailwind.config.js"),
      member,
    );
    const config = createRequire(generated)(generated) as { content: string[] };
    expect(config.content).toEqual([
      path.join(member, "src/**/*.{ts,tsx}").split(path.sep).join("/"),
    ]);
  });

  it("is the config the Tailwind entry receives", async () => {
    const member = tailwind3Member({
      "postcss.config.js": "module.exports = { plugins: { tailwindcss: {} } };\n",
    });
    const pipeline = await loadTailwind3PostcssPipeline(
      member,
      path.join(member, "postcss.config.js"),
      path.join(member, "tailwind.config.js"),
      member,
    );
    const options = (pipeline?.plugins[0] as { options?: { config?: string } }).options;
    expect(options?.config).toBe(path.join(member, "tailwind.anchored.config.cjs"));
  });
});
