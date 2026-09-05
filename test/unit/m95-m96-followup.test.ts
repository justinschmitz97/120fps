import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAndServe, type ServerPool } from "../../src/harness/index.js";
import { loadTsconfigAliases } from "../../src/project/index.js";

function poolThatThrows(err: unknown): ServerPool {
  return {
    async acquire(): Promise<never> {
      throw err;
    },
    stats: () => ({ booted: 0 }),
    async closeAll() {},
  };
}

function installReactDom(root: string): void {
  const pkgDir = path.join(root, "node_modules", "react-dom");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "react-dom", version: "19.0.0", main: "index.js" }),
  );
  fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};");
  fs.writeFileSync(path.join(pkgDir, "client.js"), "module.exports = {};");
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-m95m96-followup-"));
  fs.writeFileSync(
    path.join(tmpDir, "package.json"),
    JSON.stringify({ dependencies: { react: "18.3.1", "react-dom": "18.3.1" } }),
  );
  fs.writeFileSync(
    path.join(tmpDir, "Button.tsx"),
    "export default function Button() { return null; }\n",
  );
  installReactDom(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// M95 gap 1: a Nuxt build-time virtual module ("#build/...") can't resolve before `nuxi prepare`.
describe("Nuxt build-time virtual module (#build/...) failure", () => {
  // M108 A2: the diagnosis fires only for repos that declare nuxt.
  beforeEach(() => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        dependencies: { react: "18.3.1", "react-dom": "18.3.1" },
        devDependencies: { nuxt: "3.13.0" },
      }),
    );
  });

  it("names nuxi prepare as the remedy, with no raw package-resolution message", async () => {
    const err = new Error('Missing "#build" specifier in "@nuxt/ui" package');
    let thrown: Error | undefined;
    try {
      await buildAndServe(path.join(tmpDir, "Button.tsx"), { serverPool: poolThatThrows(err) });
      expect.unreachable();
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown!.message).toContain("nuxi prepare");
    expect(thrown!.message).toContain("#build");
    expect(thrown!.message).toContain("@nuxt/ui");
  });

  it("joins with a broken .nuxt/tsconfig.json extends warning already collected", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({ extends: "./.nuxt/tsconfig.json" }),
    );
    const warnings: string[] = [];
    loadTsconfigAliases(tmpDir, warnings);
    expect(warnings.some((w) => w.includes(".nuxt"))).toBe(true);

    const err = new Error('Missing "#build" specifier in "@nuxt/ui" package');
    let thrown: (Error & { warnings?: string[] }) | undefined;
    try {
      await buildAndServe(path.join(tmpDir, "Button.tsx"), { serverPool: poolThatThrows(err) });
      expect.unreachable();
    } catch (e) {
      thrown = e as Error & { warnings?: string[] };
    }
    // The nuxi-prepare message is composed from the same buildWarnings that carried this warning.
    expect(thrown!.message).toMatch(/tsconfig/i);
    expect(thrown!.warnings!.some((w) => w.includes(".nuxt"))).toBe(true);
  });

  // M92: nuxi prepare creates .nuxt/ without nuxt-ui's own templates; don't repeat the remedy.
  it("does not repeat the nuxi-prepare remedy when .nuxt/ already exists", async () => {
    fs.mkdirSync(path.join(tmpDir, ".nuxt"), { recursive: true });
    const err = new Error('Missing "#build" specifier in "@nuxt/ui" package');
    let thrown: Error | undefined;
    try {
      await buildAndServe(path.join(tmpDir, "Button.tsx"), { serverPool: poolThatThrows(err) });
      expect.unreachable();
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown!.message).toContain(".nuxt/ already exists");
    // Byte-identical repeat of the generic "not yet prepared" remedy is what the verifier caught.
    expect(thrown!.message).not.toContain(
      "a Nuxt build-time virtual module that does not exist until `nuxi prepare` generates",
    );
    expect(thrown!.message).not.toContain(
      "Run `nuxi prepare` in this project, then measure again.",
    );
    expect(thrown!.message).toContain("package.json scripts");
  });

  it("names a discovered repo script instead of the generic pointer when one exists", async () => {
    fs.mkdirSync(path.join(tmpDir, ".nuxt"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        dependencies: { react: "18.3.1", "react-dom": "18.3.1" },
        devDependencies: { nuxt: "3.13.0" },
        scripts: { prepare: "nuxt-module-build prepare" },
      }),
    );
    const err = new Error('Missing "#build" specifier in "@nuxt/ui" package');
    let thrown: Error | undefined;
    try {
      await buildAndServe(path.join(tmpDir, "Button.tsx"), { serverPool: poolThatThrows(err) });
      expect.unreachable();
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown!.message).toContain("npm run prepare");
  });
});

// M95 gap 2: a gitignored relative import resolving to nothing means a not-yet-generated file.
describe("gitignored generated file resolving to nothing (esbuild 'Could not resolve')", () => {
  it("names the missing generated file and a likely command instead of the raw esbuild error", async () => {
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "components/version/version.ts\n");
    fs.mkdirSync(path.join(tmpDir, "components", "version"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "components", "version", "index.tsx"),
      "import version from './version';\nexport default version;\n",
    );
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        dependencies: { react: "18.3.1", "react-dom": "18.3.1" },
        scripts: { codegen: "node scripts/gen-version.js" },
      }),
    );
    const err = new Error(
      [
        "Build failed with 1 error:",
        'components/version/index.tsx:2:20: ERROR: Could not resolve "./version"',
      ].join("\n"),
    );
    let thrown: Error | undefined;
    try {
      await buildAndServe(path.join(tmpDir, "Button.tsx"), { serverPool: poolThatThrows(err) });
      expect.unreachable();
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown!.message).toContain("components/version/version.ts");
    expect(thrown!.message).toContain("gitignored");
    expect(thrown!.message).toContain("npm run codegen");
    expect(thrown!.message).not.toMatch(/^\s*at\s/m);
  });

  it("falls through to the generic bundler diagnosis when the missing target is not gitignored (a real typo)", async () => {
    fs.mkdirSync(path.join(tmpDir, "components", "version"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "components", "version", "index.tsx"),
      "import version from './version';\nexport default version;\n",
    );
    const err = new Error(
      [
        "Build failed with 1 error:",
        'components/version/index.tsx:2:20: ERROR: Could not resolve "./version"',
      ].join("\n"),
    );
    let thrown: Error | undefined;
    try {
      await buildAndServe(path.join(tmpDir, "Button.tsx"), { serverPool: poolThatThrows(err) });
      expect.unreachable();
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown!.message).toContain("Could not resolve");
    expect(thrown!.message).not.toContain("gitignored");
  });
});

// M96 (calcom-F2): esbuild's "No matching export" error must not leak our shim's absolute path.
describe("missing shim export (esbuild 'No matching export', M96)", () => {
  it("names the shim module and the missing export, with no path inside 120fps's own installation", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { react: "18.3.1", "react-dom": "18.3.1", next: "14.2.0" } }),
    );
    const shimPath = path.resolve(
      import.meta.dirname ?? __dirname,
      "..",
      "..",
      "src",
      "harness",
      "shims",
      "next-navigation.js",
    );
    const err = new Error(
      `Build failed with 1 error:\nentry.tsx:5:9: ERROR: No matching export in "${shimPath.split("\\").join("/")}" for import "NotARealExport"`,
    );
    let thrown: Error | undefined;
    try {
      await buildAndServe(path.join(tmpDir, "Button.tsx"), { serverPool: poolThatThrows(err) });
      expect.unreachable();
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown!.message).toContain("next/navigation");
    expect(thrown!.message).toContain("NotARealExport");
    expect(thrown!.message).toContain("--no-shims");
    expect(thrown!.message).not.toContain("shims/next-navigation.js");
    expect(thrown!.message).not.toContain(process.cwd().split("\\").join("/"));
  });
});
