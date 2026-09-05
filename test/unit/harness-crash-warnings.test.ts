import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildAndServe,
  sweepActiveHarnessDirs,
  hasAnyEnvFile,
  NO_ENV_FILE_REMEDY_NOTE,
  type ServerPool,
} from "../../src/harness/index.js";
import { analyze } from "../../src/pipeline/index.js";

function poolThatThrows(err: unknown): ServerPool {
  return {
    async acquire(): Promise<never> {
      throw err;
    },
    stats: () => ({ booted: 0 }),
    async closeAll() {},
  };
}

function poolReturning(server: unknown): ServerPool {
  return {
    async acquire() {
      return { server: server as any, reused: false, include: new Set<string>() };
    },
    stats: () => ({ booted: 1 }),
    async closeAll() {},
  };
}

// assertReactDomClient probes are fs.existsSync/require.resolve; needs a real-looking react-dom.
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

describe("M79 1a: buildWarnings survive buildAndServe's throw path", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-m79-crashwarn-"));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { react: "18.3.1", "react-dom": "18.3.1", unocss: "0.58.0" } }),
    );
    // M83 #6: detectUnsupportedStyleEngines keys on the scanned import graph, not the manifest.
    fs.writeFileSync(
      path.join(tmpDir, "Button.tsx"),
      'import "unocss";\nexport default function Button() { return null; }\n',
    );
    installReactDom(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("attaches computed warnings to the error when the pool boot fails", async () => {
    let thrown: (Error & { warnings?: string[] }) | undefined;
    try {
      await buildAndServe(path.join(tmpDir, "Button.tsx"), {
        serverPool: poolThatThrows(new Error("EADDRINUSE: port in use")),
      });
      expect.unreachable();
    } catch (err) {
      thrown = err as Error & { warnings?: string[] };
    }
    expect(thrown?.warnings).toBeDefined();
    expect(thrown!.warnings!.some((w) => w.includes("unocss"))).toBe(true);
    // The immediate cause is still the message text: warnings are additive.
    expect(thrown!.message).toContain("EADDRINUSE");
  });

  it("attaches computed warnings when no listening address is returned", async () => {
    let thrown: (Error & { warnings?: string[] }) | undefined;
    try {
      await buildAndServe(path.join(tmpDir, "Button.tsx"), {
        serverPool: poolReturning({ httpServer: undefined, close: async () => {} }),
      });
      expect.unreachable();
    } catch (err) {
      thrown = err as Error & { warnings?: string[] };
    }
    expect(thrown?.warnings).toBeDefined();
    expect(thrown!.warnings!.some((w) => w.includes("unocss"))).toBe(true);
  });

  it("keeps the original error as .cause alongside the attached warnings", async () => {
    const original = new Error("EADDRINUSE: port in use");
    let thrown: (Error & { warnings?: string[] }) | undefined;
    try {
      await buildAndServe(path.join(tmpDir, "Button.tsx"), { serverPool: poolThatThrows(original) });
      expect.unreachable();
    } catch (err) {
      thrown = err as Error & { warnings?: string[] };
    }
    expect(thrown?.cause).toBe(original);
    expect(thrown?.warnings).toBeDefined();
  });
});

// M83 #7 (nuxt-ui F1/F2, mantine F1, dub F1, chakra-ui F3/F4): bootServer's catch must rmSync too.
describe("M83 #7: a crashed buildAndServe leaves no harness directory behind", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-m83-harnessdir-"));
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

  function harnessLeftovers(root: string): string[] {
    return fs.readdirSync(root).filter((name) => name.startsWith(".120fps-harness-"));
  }

  it("removes the directory when the pool boot fails (the bootServer catch)", async () => {
    let thrown: Error | undefined;
    try {
      await buildAndServe(path.join(tmpDir, "Button.tsx"), {
        serverPool: poolThatThrows(new Error("EADDRINUSE: port in use")),
      });
      expect.unreachable();
    } catch (err) {
      thrown = err as Error;
    }
    // Confirms the throw site created a directory, so this proves removal, not absence by accident.
    expect(thrown!.message).toMatch(/\.120fps-harness-/);
    expect(harnessLeftovers(tmpDir)).toEqual([]);
  });

  it("removes the directory when no listening address is returned", async () => {
    try {
      await buildAndServe(path.join(tmpDir, "Button.tsx"), {
        serverPool: poolReturning({ httpServer: undefined, close: async () => {} }),
      });
      expect.unreachable();
    } catch {
      // Rejection here is expected; only the harness-dir cleanup is under test.
    }
    // Not the bootServer-catch rmSync; the process-exit sweep covers this (see writability test).
    sweepActiveHarnessDirs();
    expect(harnessLeftovers(tmpDir)).toEqual([]);
  });
});

describe("M79 3a: unbuilt workspace package diagnosis", () => {
  let tmpDir: string;
  let consumerRoot: string;
  let sharedReal: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-m79-unbuilt-"));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
    );

    consumerRoot = path.join(tmpDir, "packages", "consumer");
    fs.mkdirSync(consumerRoot, { recursive: true });
    fs.writeFileSync(
      path.join(consumerRoot, "package.json"),
      JSON.stringify({ name: "consumer", dependencies: { react: "18.3.1", "react-dom": "18.3.1" } }),
    );
    fs.writeFileSync(
      path.join(consumerRoot, "Button.tsx"),
      "export default function Button() { return null; }\n",
    );

    sharedReal = path.join(tmpDir, "packages", "shared-real");
    fs.mkdirSync(sharedReal, { recursive: true });
    fs.writeFileSync(
      path.join(sharedReal, "package.json"),
      JSON.stringify({ name: "shared", main: "dist/index.js" }),
    );

    fs.mkdirSync(path.join(consumerRoot, "node_modules"), { recursive: true });
    installReactDom(consumerRoot);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function linkShared(): void {
    fs.symlinkSync(
      sharedReal,
      path.join(consumerRoot, "node_modules", "shared"),
      process.platform === "win32" ? "junction" : "dir",
    );
  }

  const RESOLVE_ENTRY_MESSAGE = (pkg: string): string =>
    `Failed to resolve entry for package "${pkg}". The package may have incorrect ` +
    "main/module/exports specified in its package.json.";

  it("names the package and a build step, not a package.json fix", async () => {
    let linked = true;
    try {
      linkShared();
    } catch {
      linked = false;
    }
    if (!linked) return; // environment refuses junction creation: skip, not fail
    let thrown: Error | undefined;
    try {
      await buildAndServe(path.join(consumerRoot, "Button.tsx"), {
        serverPool: poolThatThrows(new Error(RESOLVE_ENTRY_MESSAGE("shared"))),
      });
      expect.unreachable();
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown!.message).toContain("shared");
    expect(thrown!.message).toContain("build step");
    expect(thrown!.message).not.toContain("incorrect main/module/exports");
  });

  it("falls through to the unchanged message when the package's entry exists", async () => {
    let linked = true;
    try {
      linkShared();
    } catch {
      linked = false;
    }
    if (!linked) return;
    fs.mkdirSync(path.join(sharedReal, "dist"), { recursive: true });
    fs.writeFileSync(path.join(sharedReal, "dist", "index.js"), "module.exports = {};\n");
    let thrown: Error | undefined;
    try {
      await buildAndServe(path.join(consumerRoot, "Button.tsx"), {
        serverPool: poolThatThrows(new Error(RESOLVE_ENTRY_MESSAGE("shared"))),
      });
      expect.unreachable();
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown!.message).toContain("incorrect main/module/exports");
  });

  it("falls through to the unchanged message for a genuinely external dependency", async () => {
    let thrown: Error | undefined;
    try {
      await buildAndServe(path.join(consumerRoot, "Button.tsx"), {
        serverPool: poolThatThrows(new Error(RESOLVE_ENTRY_MESSAGE("some-unresolvable-external-lib"))),
      });
      expect.unreachable();
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown!.message).toContain("incorrect main/module/exports");
  });

  it("falls through when the vite message does not match the resolve-entry shape at all", async () => {
    let thrown: Error | undefined;
    try {
      await buildAndServe(path.join(consumerRoot, "Button.tsx"), {
        serverPool: poolThatThrows(new Error("Build failed with 1 error: some other esbuild failure")),
      });
      expect.unreachable();
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown!.message).toContain("some other esbuild failure");
  });
});

describe("M79 1b + M78 loose end: a preflight hard rejection is not compounded", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-m79-compound-"));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { "solid-js": "1.8.0" } }),
    );
    // solid-js "installed" so detectMissingInstall is false; unsupported-framework is the hit here.
    fs.mkdirSync(path.join(tmpDir, "node_modules", "solid-js"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "node_modules", "solid-js", "package.json"),
      JSON.stringify({ name: "solid-js", version: "1.8.0", main: "index.js" }),
    );
    // theme.scss populates transformHits before the hard rejection throws (excalidraw-F3).
    fs.writeFileSync(
      path.join(tmpDir, "Button.tsx"),
      'import "./theme.scss";\nexport default function Button() { return null; }\n',
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws exactly the preflight failure message, with no compounding note", async () => {
    let thrown: Error | undefined;
    try {
      await analyze(path.join(tmpDir, "Button.tsx"));
      expect.unreachable();
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain("solid-js");
    // Guard: a hard rejection is a complete diagnosis; a transform note stacked on top is the bug.
    expect(thrown!.message).not.toContain("measured graph imports files this harness cannot compile");
    expect(thrown!.message).not.toContain("Warnings recorded before this failure");
    expect(thrown!.message).not.toContain("[transform:css-preprocessor]");
  });
});

// M79 gap 3b (taxonomy-F1): hasAnyEnvFile answers "does either exist", not "did it define a key".
describe("M79 gap 3b: hasAnyEnvFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-m79-envfile-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("is false for a project with neither .env nor .env.local", () => {
    expect(hasAnyEnvFile(tmpDir)).toBe(false);
  });

  it("is true when .env exists at the member root", () => {
    fs.writeFileSync(path.join(tmpDir, ".env"), "NEXT_PUBLIC_X=1\n");
    expect(hasAnyEnvFile(tmpDir)).toBe(true);
  });

  it("is true when only .env.local exists", () => {
    fs.writeFileSync(path.join(tmpDir, ".env.local"), "VITE_Y=2\n");
    expect(hasAnyEnvFile(tmpDir)).toBe(true);
  });

  it("is true when the env file lives only at the workspace root", () => {
    const root = path.join(tmpDir, "repo");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
    fs.writeFileSync(path.join(root, ".env"), "NEXT_PUBLIC_X=1\n");
    const member = path.join(root, "packages", "app");
    fs.mkdirSync(member, { recursive: true });
    fs.writeFileSync(path.join(member, "package.json"), JSON.stringify({ name: "app" }));
    expect(hasAnyEnvFile(member, root)).toBe(true);
  });

  it("is true even when the file defines no NEXT_PUBLIC_/VITE_ key at all", () => {
    // hasAnyEnvFile answers "does the file exist", not "would it change process.env".
    fs.writeFileSync(path.join(tmpDir, ".env"), "DATABASE_URL=postgres://x\n");
    expect(hasAnyEnvFile(tmpDir)).toBe(true);
  });
});

describe("M79 gap 3b: NO_ENV_FILE_REMEDY_NOTE", () => {
  it("names the convention: env files only, prefixed keys, shell environment not read", () => {
    expect(NO_ENV_FILE_REMEDY_NOTE).toMatch(/\.env/);
    expect(NO_ENV_FILE_REMEDY_NOTE).toMatch(/NEXT_PUBLIC_/);
    expect(NO_ENV_FILE_REMEDY_NOTE).toMatch(/VITE_/);
    expect(NO_ENV_FILE_REMEDY_NOTE.toLowerCase()).toContain("shell");
  });
});

// Needs a real Playwright Page (e2e-only); this only pins that both wire the lazy env-remedy.
describe("M79 gap 3b: enterHarness/enterHarnessPage wiring", () => {
  const src = (name: string): string => fs.readFileSync(path.resolve("src", name), "utf-8");

  it("measure.ts's enterHarness calls waitForReadyOrFatal with a lazy env-remedy callback", () => {
    const measureSrc = src("browser/session.ts");
    const fn = measureSrc.slice(
      measureSrc.indexOf("export async function enterHarness("),
      measureSrc.indexOf("export interface CdpHolder"),
    );
    expect(fn).toContain("waitForReadyOrFatal(");
    expect(fn).toContain("hasAnyEnvFile(projectRoot)");
    expect(fn).toContain("NO_ENV_FILE_REMEDY_NOTE");
    expect(fn).not.toContain("throw enrichTimeoutError(err, errorCapture, options.label)");
  });

  it("analyze.ts's enterHarnessPage calls waitForReadyOrFatal with a lazy env-remedy callback", () => {
    const analyzeSrc = src("pipeline/analyze.ts");
    const fn = analyzeSrc.slice(
      analyzeSrc.indexOf("const enterHarnessPage = async"),
      analyzeSrc.indexOf("await enterHarnessPage();"),
    );
    expect(fn).toContain("waitForReadyOrFatal(");
    expect(fn).toContain("hasAnyEnvFile(projectRoot)");
    expect(fn).toContain("NO_ENV_FILE_REMEDY_NOTE");
  });
});
