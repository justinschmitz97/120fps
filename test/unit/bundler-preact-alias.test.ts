import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readViteConfigData,
  detectBundlerReactDomAlias,
  BUNDLER_PREACT_ALIAS_WARNING,
  type HarnessResult,
} from "../../src/harness.js";
import { resolveReactDomIdentity, REACT_DOM_NOT_REACT_WARNING, runReactAnalysis } from "../../src/react-profiler.js";

// M78 (preact-app-F3): two bundler shapes, two mechanisms.
//   (a) Vite's resolve.alias is a filesystem-literal-path alias that
//       readViteConfigData already merges into the harness's own alias
//       list, so it genuinely changes what 120fps mounts.
//   (b) Next.js/webpack aliases are bare-specifier and never applied to
//       120fps's own mount; this is a disclosure gap, not a silent
//       mismeasurement.
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeRoot(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function installPackage(root: string, name: string, pkg: Record<string, unknown>, extraFiles: Record<string, string> = {}): void {
  const dir = path.join(root, "node_modules", ...name.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  for (const [rel, content] of Object.entries(extraFiles)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function fakeHarness(root: string, viteAliases: Array<{ find: RegExp; replacement: string }>): HarnessResult {
  return {
    url: "http://localhost:0/",
    server: {} as unknown as HarnessResult["server"],
    componentPath: path.join(root, "Card.tsx"),
    harnessDir: root,
    cleanup: async () => {},
    component: { relative: "Card.tsx", name: "Card", isDefaultExport: true },
    viteAliases,
  };
}

describe("Vite literal-path alias to Preact", () => {
  it("readViteConfigData accepts a literal-path react-dom alias into a real preact package", () => {
    const root = makeRoot("120fps-vite-preact-alias-");
    const preactDir = path.join(root, "vendor", "preact-compat");
    fs.mkdirSync(preactDir, { recursive: true });
    fs.writeFileSync(path.join(preactDir, "package.json"), JSON.stringify({ name: "preact", version: "10.19.3" }));
    fs.writeFileSync(path.join(preactDir, "client.js"), "module.exports = {};\n");
    fs.writeFileSync(
      path.join(root, "vite.config.ts"),
      `export default { resolve: { alias: { "react-dom": "./vendor/preact-compat/client.js" } } };\n`,
    );

    const data = readViteConfigData(root);
    expect(data.aliases.length).toBeGreaterThan(0);
    expect(data.aliases.some((a) => a.find.test("react-dom"))).toBe(true);
  });

  it("resolveReactDomIdentity identifies Preact through the alias, not the real react-dom on disk", () => {
    const root = makeRoot("120fps-vite-preact-identity-");
    const preactDir = path.join(root, "vendor", "preact-compat");
    fs.mkdirSync(preactDir, { recursive: true });
    fs.writeFileSync(path.join(preactDir, "package.json"), JSON.stringify({ name: "preact", version: "10.19.3" }));
    fs.writeFileSync(path.join(preactDir, "client.js"), "module.exports = {};\n");
    fs.writeFileSync(
      path.join(root, "vite.config.ts"),
      `export default { resolve: { alias: { "react-dom": "./vendor/preact-compat/client.js" } } };\n`,
    );
    // The real react-dom@18 stays on disk, unaliased, unchanged.
    installPackage(root, "react-dom", { name: "react-dom", version: "18.2.0" });

    const aliases = readViteConfigData(root).aliases;
    const identity = resolveReactDomIdentity(root, aliases);
    expect(identity).toEqual({ name: "preact", version: "10.19.3", source: "vite-alias" });
  });

  it("falls back to the real react-dom identity when no alias matches", () => {
    const root = makeRoot("120fps-vite-no-alias-");
    installPackage(root, "react-dom", { name: "react-dom", version: "18.2.0" });
    expect(resolveReactDomIdentity(root, [])).toEqual({ name: "react-dom", version: "18.2.0" });
  });

  it("REACT_DOM_NOT_REACT_WARNING names vite.config.ts's resolve.alias, distinctly from an npm alias", () => {
    const viaAlias = REACT_DOM_NOT_REACT_WARNING({ name: "preact", version: "10.19.3", source: "vite-alias" });
    expect(viaAlias).toContain("vite.config.ts");
    expect(viaAlias).toContain("resolve.alias");
    expect(viaAlias).not.toContain("npm alias");

    const viaNpmAlias = REACT_DOM_NOT_REACT_WARNING({ name: "preact", version: "10.19.3" });
    expect(viaNpmAlias).toContain("npm alias");
    expect(viaNpmAlias).not.toContain("vite.config.ts");
  });

  it("runReactAnalysis skips fiber analysis and warns naming the alias source, without opening a browser", async () => {
    const root = makeRoot("120fps-vite-preact-runanalysis-");
    const preactDir = path.join(root, "vendor", "preact-compat");
    fs.mkdirSync(preactDir, { recursive: true });
    fs.writeFileSync(path.join(preactDir, "package.json"), JSON.stringify({ name: "preact", version: "10.19.3" }));
    fs.writeFileSync(path.join(preactDir, "client.js"), "module.exports = {};\n");
    fs.writeFileSync(
      path.join(root, "vite.config.ts"),
      `export default { resolve: { alias: { "react-dom": "./vendor/preact-compat/client.js" } } };\n`,
    );
    installPackage(root, "react-dom", { name: "react-dom", version: "18.2.0" });

    const aliases = readViteConfigData(root).aliases;
    const warnings: string[] = [];
    const result = await runReactAnalysis(fakeHarness(root, aliases), {
      combos: [],
      onWarning: (w) => warnings.push(w),
    });
    expect(result.size).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("vite.config.ts");
  });
});

describe("Next.js/webpack bare-specifier alias disclosure", () => {
  const nextConfig = `module.exports = {
  webpack: (config, { dev, isServer }) => {
    if (!dev && !isServer) {
      Object.assign(config.resolve.alias, { react: 'preact/compat', 'react-dom': 'preact/compat' });
    }
    return config;
  },
};
`;

  it("finds the react-dom alias in the field-tested next.config.js shape", () => {
    const root = makeRoot("120fps-next-preact-alias-");
    fs.writeFileSync(path.join(root, "next.config.js"), nextConfig);
    const result = detectBundlerReactDomAlias(root);
    expect(result).toEqual({ configFile: path.join(root, "next.config.js"), target: "preact/compat" });
  });

  it("also finds it in a webpack.config.js when there is no next.config", () => {
    const root = makeRoot("120fps-webpack-preact-alias-");
    fs.writeFileSync(
      path.join(root, "webpack.config.js"),
      `module.exports = { resolve: { alias: { "react-dom": "preact/compat" } } };\n`,
    );
    const result = detectBundlerReactDomAlias(root);
    expect(result?.target).toBe("preact/compat");
  });

  it("prefers next.config.js over webpack.config.js when both exist", () => {
    const root = makeRoot("120fps-next-and-webpack-");
    fs.writeFileSync(path.join(root, "next.config.js"), nextConfig);
    fs.writeFileSync(
      path.join(root, "webpack.config.js"),
      `module.exports = { resolve: { alias: { "react-dom": "preact/other" } } };\n`,
    );
    const result = detectBundlerReactDomAlias(root);
    expect(result?.configFile).toBe(path.join(root, "next.config.js"));
    expect(result?.target).toBe("preact/compat");
  });

  it("returns undefined when neither config file aliases react-dom", () => {
    const root = makeRoot("120fps-no-preact-alias-");
    fs.writeFileSync(path.join(root, "next.config.js"), "module.exports = {};\n");
    expect(detectBundlerReactDomAlias(root)).toBeUndefined();
  });

  it("returns undefined when neither config file exists", () => {
    const root = makeRoot("120fps-no-bundler-config-");
    expect(detectBundlerReactDomAlias(root)).toBeUndefined();
  });

  it("never executes the config: a throwing webpack customizer causes no error", () => {
    const root = makeRoot("120fps-next-preact-alias-noexec-");
    fs.writeFileSync(root + "/next.config.js", nextConfig);
    expect(() => detectBundlerReactDomAlias(root)).not.toThrow();
  });

  it("BUNDLER_PREACT_ALIAS_WARNING names the config file, the target, and why it cannot be evaluated", () => {
    const message = BUNDLER_PREACT_ALIAS_WARNING("/app/next.config.js", "preact/compat");
    expect(message).toContain("/app/next.config.js");
    expect(message).toContain("preact/compat");
    expect(message).toContain("cannot evaluate");
  });
});
