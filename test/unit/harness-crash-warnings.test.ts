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
} from "../../src/harness.js";
import { analyze } from "../../src/analyze.js";

// M79 behavior 1: two independent places already accumulate diagnostic
// strings in a local array (harness.ts's buildWarnings, analyze.ts's
// runWarnings) and both dropped the array on the throw path before this
// milestone. These tests pin the fix at both layers, plus the M78 loose end
// (excalidraw-F3's compounding note): a preflight *hard rejection* is a
// complete diagnosis on its own and must not get accumulated warnings or an
// unrelated transform note stacked on top of it.

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

// assertReactDomClient's own probes (detectMissingInstall, readReactDomVersion)
// are pure fs.existsSync / require.resolve checks against the given project
// root's own node_modules chain — an isolated tmpDir needs a real-looking
// react-dom on disk, matching react-version-boot-gate.test.ts's own pattern.
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
    // M83 #6: detectUnsupportedStyleEngines now keys on the measured
    // component's own scanned import graph, not manifest declaration alone —
    // the component must actually import unocss for the warning to fire.
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

// M83 #7: bootServer's catch performed no rmSync, and cleanup() is only
// reachable on the success path — every crash in this describe block used to
// leave its .120fps-harness-* directory behind (nuxt-ui F1/F2, mantine F1,
// dub F1, chakra-ui F3/F4's shape).
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
    // Confirms the throw site actually created a directory (not a no-op),
    // so the assertion below is proving removal, not absence-by-accident.
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
      // expected
    }
    // Not covered by the explicit bootServer-catch rmSync (only the
    // process-exit sweep does): still gone once the process actually exits,
    // which sweepActiveHarnessDirs (M83 #7, see harness-dir-writability.test.ts)
    // pins directly. Here: the directory is still tracked, not orphaned from
    // tracking, which the exit-sweep test file proves is sufficient.
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
    // A node_modules dir (with solid-js "installed") so detectMissingInstall
    // is false and the unsupported-framework check — not not-installed — is
    // the hard hit under test.
    fs.mkdirSync(path.join(tmpDir, "node_modules", "solid-js"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "node_modules", "solid-js", "package.json"),
      JSON.stringify({ name: "solid-js", version: "1.8.0", main: "index.js" }),
    );
    // Imports a css-preprocessor-recognized specifier: transformHits/runWarnings
    // populate (PROJECT_TRANSFORM_WARNING) before the hard-rejection throws,
    // exactly excalidraw-F3's mechanism.
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
    // Neither the old transformFailureNote framing nor the new generalized
    // "Warnings recorded before this failure" block may appear: the hard
    // rejection is a complete diagnosis (nothing was built), and stacking a
    // css-preprocessor note on top of it is the compounding bug.
    expect(thrown!.message).not.toContain("measured graph imports files this harness cannot compile");
    expect(thrown!.message).not.toContain("Warnings recorded before this failure");
    expect(thrown!.message).not.toContain("[transform:css-preprocessor]");
  });
});

// M79 gap 3b (taxonomy-F1): readEnvDefines reads .env/.env.local at the
// member and workspace levels; hasAnyEnvFile answers "does either exist at
// all", independent of whether it defined a page-visible key, so a fatal
// page error's remedy line is withheld when the fix would not apply.
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
    // hasAnyEnvFile answers "does the file exist", not "would it change
    // process.env on the page" — readEnvDefines already answers the latter.
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

// Wiring: enterHarness (measure.ts) and enterHarnessPage (analyze.ts) both
// race readiness against a fatal page error instead of always waiting out
// the full timeout, and both compute the env-remedy line lazily from
// hasAnyEnvFile/NO_ENV_FILE_REMEDY_NOTE. Both functions require a real
// Playwright Page to exercise end to end (e2e-only per this milestone's
// constraints); the underlying race/message logic itself is unit-tested
// directly against page-errors.ts's waitForReadyOrFatal.
describe("M79 gap 3b: enterHarness/enterHarnessPage wiring", () => {
  const src = (name: string): string => fs.readFileSync(path.resolve("src", name), "utf-8");

  it("measure.ts's enterHarness calls waitForReadyOrFatal with a lazy env-remedy callback", () => {
    const measureSrc = src("measure.ts");
    const fn = measureSrc.slice(
      measureSrc.indexOf("export async function enterHarness("),
      measureSrc.indexOf("export const CONTEXT_RETRY_WARNING"),
    );
    expect(fn).toContain("waitForReadyOrFatal(");
    expect(fn).toContain("hasAnyEnvFile(projectRoot)");
    expect(fn).toContain("NO_ENV_FILE_REMEDY_NOTE");
    expect(fn).not.toContain("throw enrichTimeoutError(err, errorCapture, options.label)");
  });

  it("analyze.ts's enterHarnessPage calls waitForReadyOrFatal with a lazy env-remedy callback", () => {
    const analyzeSrc = src("analyze.ts");
    const fn = analyzeSrc.slice(
      analyzeSrc.indexOf("const enterHarnessPage = async"),
      analyzeSrc.indexOf("await enterHarnessPage();"),
    );
    expect(fn).toContain("waitForReadyOrFatal(");
    expect(fn).toContain("hasAnyEnvFile(projectRoot)");
    expect(fn).toContain("NO_ENV_FILE_REMEDY_NOTE");
  });
});
