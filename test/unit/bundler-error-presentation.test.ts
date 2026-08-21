import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildAndServe,
  presentBundlerFailure,
  stylesheetReadFailureTarget,
  CSS_UNREADABLE_DROPPED_WARNING,
  type ServerPool,
} from "../../src/harness.js";
import {
  resolveFatalProcessError,
  resetFatalProcessErrorGuard,
  setCurrentRunProjectRoot,
  pushCurrentRunWarning,
  resetCurrentRunWarnings,
} from "../../src/cli.js";

// M94: shadcn-ui's two live repro shapes -- a raw PostCSS ENOENT and a raw
// Vite "Failed to resolve import" -- each with ten/eight frames of bundler
// internals under 120fps's own node_modules. Both must re-present as a named
// 120fps error with no node_modules substring anywhere in the message.

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-m94-bundlererr-"));
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

const POSTCSS_ENOENT_ERROR = new Error(
  [
    "component harness did not become ready within timeout. Page errors:",
    "  - [vite] Internal Server Error",
    "[postcss] ENOENT: no such file or directory, open 'E:\\repositories\\shadcn-ui\\apps\\v4\\shadcn\\tailwind.css'",
    "    at async open (node:internal/fs/promises:640:25)",
    "    at async Object.readFile (node:internal/fs/promises:1046:14)",
    "    at async LazyResult.runOnRoot (C:\\Projekte\\120fps\\node_modules\\.pnpm\\postcss@8.4.35\\node_modules\\postcss\\lib\\lazy-result.js:88:16)",
    "    at async LazyResult.async (C:\\Projekte\\120fps\\node_modules\\.pnpm\\postcss@8.4.35\\node_modules\\postcss\\lib\\lazy-result.js:192:26)",
    "  - response 500: GET http://localhost:5180/app/globals.css",
  ].join("\n"),
);

const VITE_IMPORT_RESOLVE_ERROR = new Error(
  [
    "component harness did not become ready within timeout. Page errors:",
    "  - [vite] Internal Server Error",
    'Failed to resolve import "@shadcn/react/message-scroller" from "registry/new-york-v4/ui/message-scroller.tsx". Does the file exist?',
    "    at TransformPluginContext._formatLog (C:\\Projekte\\120fps\\node_modules\\.pnpm\\vite@6.4.2\\node_modules\\vite\\dist\\node\\chunks\\dep-Dq2t6Dq0.js:42553:41)",
    "    at TransformPluginContext.error (C:\\Projekte\\120fps\\node_modules\\.pnpm\\vite@6.4.2\\node_modules\\vite\\dist\\node\\chunks\\dep-Dq2t6Dq0.js:42550:16)",
    "  - response 500: GET http://localhost:5179/registry/new-york-v4/ui/message-scroller.tsx",
  ].join("\n"),
);

describe("bundler failure re-presentation (M94)", () => {
  it("re-presents a raw Vite 'Failed to resolve import' error naming the target and importer, with no node_modules substring", async () => {
    let thrown: Error | undefined;
    try {
      await buildAndServe(path.join(tmpDir, "Button.tsx"), {
        serverPool: poolThatThrows(VITE_IMPORT_RESOLVE_ERROR),
      });
      expect.unreachable();
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown!.message).toContain("@shadcn/react/message-scroller");
    expect(thrown!.message).toContain("registry/new-york-v4/ui/message-scroller.tsx");
    expect(thrown!.message).not.toContain("node_modules");
    expect(thrown!.message).not.toMatch(/^\s*at\s/m);
  });

  it("re-presents a raw PostCSS ENOENT error naming the missing stylesheet, with no node_modules substring", async () => {
    let thrown: Error | undefined;
    try {
      await buildAndServe(path.join(tmpDir, "Button.tsx"), {
        serverPool: poolThatThrows(POSTCSS_ENOENT_ERROR),
      });
      expect.unreachable();
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown!.message).toContain("tailwind.css");
    expect(thrown!.message).toContain("--no-css");
    expect(thrown!.message).not.toContain("node_modules");
    expect(thrown!.message).not.toMatch(/^\s*at\s/m);
  });

  it("strips stack frames from an unrecognized bundler error shape too, preserving the descriptive text", async () => {
    const unrecognized = new Error(
      [
        "Something else entirely broke",
        "    at deepInternal (C:\\Projekte\\120fps\\node_modules\\.pnpm\\some-pkg@1.0.0\\node_modules\\some-pkg\\index.js:1:1)",
      ].join("\n"),
    );
    let thrown: Error | undefined;
    try {
      await buildAndServe(path.join(tmpDir, "Button.tsx"), {
        serverPool: poolThatThrows(unrecognized),
      });
      expect.unreachable();
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown!.message).toContain("Something else entirely broke");
    expect(thrown!.message).not.toContain("node_modules");
    expect(thrown!.message).not.toMatch(/^\s*at\s/m);
  });

  // M92: conservative stripping keeps a frame pointing into the target
  // repository -- only a frame inside 120fps's own installation must go.
  it("keeps a stack frame pointing into the target repository while stripping 120fps's own", async () => {
    const mixed = new Error(
      [
        "Something failed during a real render",
        "    at Button (E:\\repositories\\twenty\\packages\\twenty-ui\\src\\input\\Button\\Button.tsx:12:3)",
        "    at deepInternal (C:\\Projekte\\120fps\\node_modules\\.pnpm\\vite@6.4.2\\node_modules\\vite\\dist\\node\\chunks\\dep-Dq2t6Dq0.js:1:1)",
      ].join("\n"),
    );
    let thrown: Error | undefined;
    try {
      await buildAndServe(path.join(tmpDir, "Button.tsx"), { serverPool: poolThatThrows(mixed) });
      expect.unreachable();
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown!.message).toContain("Button.tsx:12:3");
    expect(thrown!.message).toContain("E:\\repositories\\twenty");
    expect(thrown!.message).not.toContain("C:\\Projekte\\120fps");
    expect(thrown!.message).not.toContain("node_modules\\.pnpm\\vite@");
  });
});

// M92: ITEM 1 -- one diagnosis-and-disclosure pipeline (presentBundlerFailure)
// shared by all three failure-arrival surfaces, so a shape recognized on one
// is recognized on all three. Surface 1 (buildAndServe's own boot catch,
// above) is already covered end to end. These prove surfaces 2 and 3 route
// through the identical function without duplicating the chain.
describe("presentBundlerFailure: surface 2, the page-error channel (M92)", () => {
  // twenty's exact repro: the dev server boots, a browser request for
  // Button.module.scss fails Vite's sass transform, and the raw compiler
  // error (with 120fps's own node_modules frames) arrives as page-error text
  // wrapped in "did not become ready" -- never touching buildAndServe's own
  // catch (surface 1), since the server started successfully.
  it("strips 120fps's own frames from a sass compile failure arriving as page-error text", () => {
    const pageErrorText = [
      "component harness did not become ready within timeout. Page errors:",
      "  - [vite] Internal Server Error",
      "[sass] Error: Undefined mixin.",
      "  ╷",
      "2 │   @include focus-ring;",
      "  │   ^^^^^^^^^^^^^^",
      "  ╵",
      "  Button.module.scss 65:3",
      "    at async Object.run (file:///C:/Projekte/120fps/node_modules/.pnpm/vite@6.4.2_@types+node@22.19.17_jiti@2.7.0_lightningcss@1.32.0/node_modules/vite/dist/node/chunks/dep-Dq2t6Dq0.js:44582:22)",
      "    at async compileCSSPreprocessors (file:///C:/Projekte/120fps/node_modules/.pnpm/vite@6.4.2_@types+node@22.19.17_jiti@2.7.0_lightningcss@1.32.0/node_modules/vite/dist/node/chunks/dep-Dq2t6Dq0.js:43644:28)",
    ].join("\n");
    const presented = presentBundlerFailure(pageErrorText, tmpDir, []);
    expect(presented).toContain("did not become ready");
    expect(presented).toContain("Undefined mixin");
    expect(presented).not.toContain("C:/Projekte/120fps");
    expect(presented).not.toContain("node_modules/.pnpm/vite@");
    expect(presented).not.toMatch(/^\s*at\s/m);
  });

  // shadcn-ui's exact repro: postcss ENOENT on its own zero-config default,
  // also arriving on the page-error channel.
  it("re-presents a postcss ENOENT arriving on the page-error channel, naming the missing stylesheet", () => {
    const pageErrorText = [
      "component harness did not become ready within timeout. Page errors:",
      "  - [vite] Internal Server Error",
      "[postcss] ENOENT: no such file or directory, open 'E:\\repositories\\shadcn-ui\\apps\\v4\\shadcn\\tailwind.css'",
      "    at async open (node:internal/fs/promises:640:25)",
      "    at async LazyResult.runOnRoot (C:\\Projekte\\120fps\\node_modules\\.pnpm\\postcss@8.5.13\\node_modules\\postcss\\lib\\lazy-result.js:88:16)",
      "  - response 500: GET http://localhost:5183/app/globals.css",
    ].join("\n");
    const presented = presentBundlerFailure(pageErrorText, tmpDir, []);
    expect(presented).toContain("tailwind.css");
    expect(presented).toContain("--no-css");
    expect(presented).not.toContain("C:\\Projekte\\120fps");
    expect(presented).not.toContain("node_modules\\.pnpm\\postcss@");
  });

  // Keeps a frame into the target repo's own node_modules -- conservative
  // stripping, not blanket removal, on this surface too.
  it("keeps a frame pointing into the target repo's own node_modules on the page-error channel", () => {
    const pageErrorText = [
      "component harness did not become ready within timeout. Page errors:",
      "  - [vite] Internal Server Error",
      "[sass] Error: Undefined mixin.",
      "    at compileString (E:\\repositories\\twenty\\node_modules\\sass-embedded\\dist\\lib\\src\\compile.js:40:1)",
      "    at async Object.run (C:\\Projekte\\120fps\\node_modules\\.pnpm\\vite@6.4.2\\node_modules\\vite\\dist\\node\\chunks\\dep-Dq2t6Dq0.js:44582:22)",
    ].join("\n");
    const presented = presentBundlerFailure(pageErrorText, tmpDir, []);
    expect(presented).toContain("E:\\repositories\\twenty\\node_modules\\sass-embedded");
    expect(presented).not.toContain("C:\\Projekte\\120fps");
  });
});

// M89 defect 3 (shadcn-ui, live proof): a discovered stylesheet that
// resolves to a real file can still fail to compile because something IT
// references internally does not -- the governing policy is to drop it and
// measure unstyled instead of aborting the run, but *only* for this exact
// "cannot be resolved/read" shape. `stylesheetReadFailureTarget` is the
// detector analyze.ts's harness-ready-wait catch uses to decide whether to
// retry without the stylesheet or let a genuine compile error keep failing
// the run loudly.
describe("stylesheetReadFailureTarget (M89 defect 3)", () => {
  it("extracts the missing file from the exact live-proof page-error shape", () => {
    const pageErrorText = [
      "component harness did not become ready within timeout. Page errors:",
      "  - [vite] Internal Server Error",
      "[postcss] ENOENT: no such file or directory, open 'E:\\repositories\\shadcn-ui\\apps\\v4\\shadcn\\tailwind.css'",
      "    at async open (node:internal/fs/promises:640:25)",
    ].join("\n");
    expect(stylesheetReadFailureTarget(pageErrorText)).toBe(
      "E:\\repositories\\shadcn-ui\\apps\\v4\\shadcn\\tailwind.css",
    );
  });

  it("negative case: a stylesheet that resolves and then fails to compile does not match (must keep failing loudly)", () => {
    const sassCompileFailure = [
      "component harness did not become ready within timeout. Page errors:",
      "  - [vite] Internal Server Error",
      "[sass] Error: Undefined mixin.",
      "  Button.module.scss 65:3",
    ].join("\n");
    expect(stylesheetReadFailureTarget(sassCompileFailure)).toBeUndefined();
  });

  it("does not match an unrelated failure", () => {
    expect(stylesheetReadFailureTarget("Execution context was destroyed")).toBeUndefined();
  });

  it("does not match a Vite import-resolve failure for a non-stylesheet module (a real project error, not a stylesheet read failure)", () => {
    const viteImportFailure =
      'Failed to resolve import "@shadcn/react/message-scroller" from "registry/new-york-v4/ui/message-scroller.tsx". Does the file exist?';
    expect(stylesheetReadFailureTarget(viteImportFailure)).toBeUndefined();
  });
});

describe("CSS_UNREADABLE_DROPPED_WARNING (M89 defect 3)", () => {
  it("names the single dropped stylesheet, the missing target, and both remedies", () => {
    const warning = CSS_UNREADABLE_DROPPED_WARNING(
      "E:\\repositories\\shadcn-ui\\apps\\v4\\shadcn\\tailwind.css",
      ["app/globals.css"],
    );
    expect(warning).toContain("app/globals.css");
    expect(warning).toContain("tailwind.css");
    expect(warning).toContain("measured unstyled");
    expect(warning).toContain("--css");
    expect(warning).toContain("Layout-dependent metrics");
  });

  it("states 'all N' when every discovered stylesheet drops out together", () => {
    const warning = CSS_UNREADABLE_DROPPED_WARNING("tailwind.css", ["a.css", "b.css"]);
    expect(warning).toContain("all 2 discovered stylesheets");
    expect(warning).toContain("a.css");
    expect(warning).toContain("b.css");
  });
});

// M89 defect 3: analyze.ts's own wiring, verified the same way M89's
// delta-phase-stall-hint.test.ts verifies analyze.ts's retagPhaseError
// wiring -- source-level inspection, not a live browser run. No existing
// test in this codebase drives a real Vite dev server through a genuine
// PostCSS transform failure to unit-test this end to end (the same
// unit/e2e boundary M89's own spec already draws); this instead confirms
// the retry is actually composed around enterHarnessPage() the way the
// pure-function tests above assume it is.
describe("M89 defect 3: analyze.ts wiring (source-level check)", () => {
  it("wraps the first enterHarnessPage() call, degrades only on stylesheetReadFailureTarget, and rebuilds with no cssFiles", () => {
    const src = fs.readFileSync(path.resolve("src", "analyze.ts"), "utf-8");
    const start = src.indexOf("try {\n      await enterHarnessPage();");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("\n    }\n\n    // A structurally inferred tree", start));
    expect(block).toContain("stylesheetReadFailureTarget(message)");
    expect(block).toContain("if (!missingTarget) throw err;");
    expect(block).toContain("CSS_UNREADABLE_DROPPED_WARNING(missingTarget, droppedFiles)");
    expect(block).toContain('cssReport.layer = "unreadable"');
    expect(block).toContain("cssFiles: undefined");
    expect(block).toContain("fingerprintValue = undefined");
    expect(block).toContain("await enterHarnessPage();");
  });
});

// Item A: the other end of the wire -- analyze.ts must actually report
// warnings out through AnalyzeOptions.onWarning as it discovers them, and
// cli.ts's runOne must actually pass pushCurrentRunWarning as that callback.
// Source-level, for the same reason as the M89 defect 3 wiring check above:
// exercising this live needs a real browser run.
describe("Item A: warnings-accumulator wiring (source-level check)", () => {
  it("analyze.ts reports the Stylesheets: decision line and every new runWarnings entry through options.onWarning", () => {
    const src = fs.readFileSync(path.resolve("src", "analyze.ts"), "utf-8");
    expect(src).toContain("const cssDecisionWarning = formatStylesheetsLine(cssReport);");
    expect(src).toContain("options.onWarning?.(cssDecisionWarning);");
    const onWarningStart = src.indexOf("const onWarning = (warning: string): void => {");
    expect(onWarningStart).toBeGreaterThan(-1);
    const onWarningBlock = src.slice(onWarningStart, src.indexOf("};", onWarningStart));
    expect(onWarningBlock).toContain("options.onWarning?.(warning);");
  });

  it("cli.ts's runOne passes pushCurrentRunWarning as analyze()'s onWarning option", () => {
    const src = fs.readFileSync(path.resolve("src", "cli.ts"), "utf-8");
    const start = src.indexOf("async function runOne(");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("\n}\n", start));
    expect(block).toContain("onWarning: pushCurrentRunWarning,");
  });
});

describe("presentBundlerFailure: surface 3, the async unhandled-rejection channel (M92, ant-design-F5/F7/F9)", () => {
  beforeEach(() => {
    resetFatalProcessErrorGuard();
    setCurrentRunProjectRoot(undefined);
    resetCurrentRunWarnings();
  });
  afterEach(() => {
    resetFatalProcessErrorGuard();
    setCurrentRunProjectRoot(undefined);
    resetCurrentRunWarnings();
  });

  // ant-design's exact repro: a fire-and-forget Vite dependency-optimizer
  // scan rejects after buildAndServe's own try/catch already exited
  // successfully, reaching process.on("unhandledRejection") directly --
  // neither surface 1 nor surface 2 ever saw this error.
  it("names the gitignored generated file instead of the raw esbuild error, when a project root is known", () => {
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
    const raw = new Error(
      [
        "Build failed with 1 error:",
        'components/version/index.tsx:2:20: ERROR: Could not resolve "./version"',
        "    at failureErrorWithLog (C:\\Projekte\\120fps\\node_modules\\.pnpm\\esbuild@0.25.12\\node_modules\\esbuild\\lib\\main.js:1467:15)",
      ].join("\n"),
    );

    setCurrentRunProjectRoot(tmpDir);
    const resolved = resolveFatalProcessError(raw, undefined);

    expect(resolved).toBeDefined();
    expect(resolved!.output).toContain("components/version/version.ts");
    expect(resolved!.output).toContain("gitignored");
    expect(resolved!.output).toContain("npm run codegen");
    expect(resolved!.output).not.toContain("C:\\Projekte\\120fps");
    expect(resolved!.output).not.toMatch(/^\s*at\s/m);
  });

  it("passes the raw error through unchanged when no project root is known", () => {
    const raw = new Error("some unrelated rejection");
    setCurrentRunProjectRoot(undefined);
    const resolved = resolveFatalProcessError(raw, undefined);
    expect(resolved!.output).toContain("some unrelated rejection");
  });

  // Item A (M90 follow-up): the gitignore diagnosis above already worked;
  // this is the other half of the same contract -- every warning
  // accumulated before the crash (the `Stylesheets:` decision line, plus
  // anything else discovered during the run) must reach this surface too,
  // the same way it already reaches surfaces 1 and 2 (analyze.ts's own
  // local catch). Exercised through the exported accumulator directly
  // (pushCurrentRunWarning), the same seam runOne wires AnalyzeOptions.onWarning
  // to -- not by re-running a real analyze(), which would need a live
  // browser and dev server (out of scope here, same reasoning as M89's own
  // unit/e2e boundary).
  it("appends the accumulated 'Warnings recorded before this failure:' block, same wording as surfaces 1/2", () => {
    setCurrentRunProjectRoot(tmpDir);
    pushCurrentRunWarning("Stylesheets: app/globals.css (matched a conventional filename)");
    pushCurrentRunWarning("the dev server reloaded the page mid-measurement; the affected sample was retried once");

    const raw = new Error("some unrelated rejection during setup");
    const resolved = resolveFatalProcessError(raw, undefined);

    expect(resolved!.output).toContain("some unrelated rejection during setup");
    expect(resolved!.output).toContain("Warnings recorded before this failure:");
    expect(resolved!.output).toContain("Stylesheets: app/globals.css (matched a conventional filename)");
    expect(resolved!.output).toContain(
      "the dev server reloaded the page mid-measurement; the affected sample was retried once",
    );
  });

  it("prints no warnings block when nothing was accumulated (unchanged from before this fix)", () => {
    setCurrentRunProjectRoot(tmpDir);
    const raw = new Error("some unrelated rejection");
    const resolved = resolveFatalProcessError(raw, undefined);
    expect(resolved!.output).not.toContain("Warnings recorded before this failure:");
  });

  it("still names the gitignored file's diagnosis, with the warnings block appended after it", () => {
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
    setCurrentRunProjectRoot(tmpDir);
    pushCurrentRunWarning("Stylesheets: none found (checked the project entry, conventional filenames, and the largest stylesheet under the project)");

    const raw = new Error(
      [
        "Build failed with 1 error:",
        'components/version/index.tsx:2:20: ERROR: Could not resolve "./version"',
        "    at failureErrorWithLog (C:\\Projekte\\120fps\\node_modules\\.pnpm\\esbuild@0.25.12\\node_modules\\esbuild\\lib\\main.js:1467:15)",
      ].join("\n"),
    );
    const resolved = resolveFatalProcessError(raw, undefined);

    expect(resolved!.output).toContain("components/version/version.ts");
    expect(resolved!.output).toContain("gitignored");
    expect(resolved!.output).toContain("npm run codegen");
    expect(resolved!.output).toContain("Warnings recorded before this failure:");
    expect(resolved!.output).toContain("Stylesheets: none found");
    // The diagnosis stays the lead sentence; the warnings block trails it.
    expect(resolved!.output.indexOf("gitignored")).toBeLessThan(
      resolved!.output.indexOf("Warnings recorded before this failure:"),
    );
  });
});
