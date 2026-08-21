import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAndServe, loadTsconfigAliases, type ServerPool } from "../../src/harness.js";

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

// M95 gap 1 (nuxt-ui): a Nuxt build-time virtual module ("#build/...") cannot
// resolve before `nuxi prepare` generates .nuxt/. Joined with the
// tsconfig-extends warning already in buildWarnings when both point at the
// same generated directory.
describe("Nuxt build-time virtual module (#build/...) failure", () => {
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
    // The join happens because the same buildWarnings that carried the
    // tsconfig warning are inspected when composing the nuxi-prepare message.
    expect(thrown!.message).toMatch(/tsconfig/i);
    expect(thrown!.warnings!.some((w) => w.includes(".nuxt"))).toBe(true);
  });

  // M92 (nuxt-ui, verified post-fix): running the advised `nuxi prepare`
  // creates .nuxt/ without producing this module's own generated templates
  // (nuxt-ui's root has no nuxt.config.ts of its own, so a root-level
  // prepare never runs @nuxt/ui's module hooks). The remedy must stop
  // advising a command the run's own evidence (.nuxt/ already exists) shows
  // was already run, and must not name an unverified script.
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
    // The bare "not yet prepared" remedy sentence must not appear verbatim --
    // that is the exact byte-identical repeat the verifier caught.
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

// M95 gap 2 (ant-design): a relative import resolving to nothing, where the
// target is gitignored, is a generated-file-not-yet-produced shape.
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

// M96 (calcom-F2, Lane C's second MUST deferred here): esbuild's own static
// "No matching export" error, when the file it names is one of 120fps's own
// shims, must not leak that absolute dist/shims path.
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
