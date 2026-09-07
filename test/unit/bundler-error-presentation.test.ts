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
} from "../../src/harness/index.js";
import {
  resolveFatalProcessError,
  resetFatalProcessErrorGuard,
  setCurrentRunProjectRoot,
  pushCurrentRunWarning,
  resetCurrentRunWarnings,
} from "../../src/cli/index.js";

// M94 (shadcn-ui): both live repro shapes must re-present with no node_modules substring left.

// Stripped frames are the ones under the harness's own installation (worktree/clone/CI dir).
const INSTALL_ROOT = path.resolve(import.meta.dirname, "..", "..");
const WIN_INSTALL_ROOT = INSTALL_ROOT.replace(/\//g, "\\");
const POSIX_INSTALL_ROOT = INSTALL_ROOT.replace(/\\/g, "/");

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
    "[vite] Internal Server Error",
    "[postcss] ENOENT: no such file or directory, open 'E:\\repositories\\shadcn-ui\\apps\\v4\\shadcn\\tailwind.css'",
    "    at async open (node:internal/fs/promises:640:25)",
    "    at async Object.readFile (node:internal/fs/promises:1046:14)",
    `    at async LazyResult.runOnRoot (${WIN_INSTALL_ROOT}\\node_modules\\.pnpm\\postcss@8.4.35\\node_modules\\postcss\\lib\\lazy-result.js:88:16)`,
    `    at async LazyResult.async (${WIN_INSTALL_ROOT}\\node_modules\\.pnpm\\postcss@8.4.35\\node_modules\\postcss\\lib\\lazy-result.js:192:26)`,
  ].join("\n"),
);

const VITE_IMPORT_RESOLVE_ERROR = new Error(
  [
    "[vite] Internal Server Error",
    'Failed to resolve import "@shadcn/react/message-scroller" from "registry/new-york-v4/ui/message-scroller.tsx". Does the file exist?',
    `    at TransformPluginContext._formatLog (${WIN_INSTALL_ROOT}\\node_modules\\.pnpm\\vite@6.4.2\\node_modules\\vite\\dist\\node\\chunks\\dep-Dq2t6Dq0.js:42553:41)`,
    `    at TransformPluginContext.error (${WIN_INSTALL_ROOT}\\node_modules\\.pnpm\\vite@6.4.2\\node_modules\\vite\\dist\\node\\chunks\\dep-Dq2t6Dq0.js:42550:16)`,
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
        `    at deepInternal (${WIN_INSTALL_ROOT}\\node_modules\\.pnpm\\some-pkg@1.0.0\\node_modules\\some-pkg\\index.js:1:1)`,
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

  // M92: conservative stripping removes only frames inside 120fps's own installation.
  it("keeps a stack frame pointing into the target repository while stripping 120fps's own", async () => {
    const mixed = new Error(
      [
        "Something failed during a real render",
        "    at Button (E:\\repositories\\twenty\\packages\\twenty-ui\\src\\input\\Button\\Button.tsx:12:3)",
        `    at deepInternal (${WIN_INSTALL_ROOT}\\node_modules\\.pnpm\\vite@6.4.2\\node_modules\\vite\\dist\\node\\chunks\\dep-Dq2t6Dq0.js:1:1)`,
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
    expect(thrown!.message).not.toContain(WIN_INSTALL_ROOT);
    expect(thrown!.message).not.toContain("node_modules\\.pnpm\\vite@");
  });
});

// M92 item 1: one presentBundlerFailure pipeline serves all three failure-arrival surfaces.
describe("presentBundlerFailure: surface 2, the page-error channel (M92)", () => {
  // twenty's repro: a sass transform failure arrives as page-error text, not via surface 1's catch.
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
      `    at async Object.run (file:///${POSIX_INSTALL_ROOT}/node_modules/.pnpm/vite@6.4.2_@types+node@22.19.17_jiti@2.7.0_lightningcss@1.32.0/node_modules/vite/dist/node/chunks/dep-Dq2t6Dq0.js:44582:22)`,
      `    at async compileCSSPreprocessors (file:///${POSIX_INSTALL_ROOT}/node_modules/.pnpm/vite@6.4.2_@types+node@22.19.17_jiti@2.7.0_lightningcss@1.32.0/node_modules/vite/dist/node/chunks/dep-Dq2t6Dq0.js:43644:28)`,
    ].join("\n");
    const presented = presentBundlerFailure(pageErrorText, tmpDir, []);
    expect(presented).toContain("did not become ready");
    expect(presented).toContain("Undefined mixin");
    expect(presented).not.toContain(POSIX_INSTALL_ROOT);
    expect(presented).not.toContain("node_modules/.pnpm/vite@");
    expect(presented).not.toMatch(/^\s*at\s/m);
  });

  // shadcn-ui's repro: postcss ENOENT on its own zero-config default, on the page-error channel.
  it("re-presents a postcss ENOENT arriving on the page-error channel, naming the missing stylesheet", () => {
    const pageErrorText = [
      "component harness did not become ready within timeout. Page errors:",
      "  - [vite] Internal Server Error",
      "[postcss] ENOENT: no such file or directory, open 'E:\\repositories\\shadcn-ui\\apps\\v4\\shadcn\\tailwind.css'",
      "    at async open (node:internal/fs/promises:640:25)",
      `    at async LazyResult.runOnRoot (${WIN_INSTALL_ROOT}\\node_modules\\.pnpm\\postcss@8.5.13\\node_modules\\postcss\\lib\\lazy-result.js:88:16)`,
      "  - response 500: GET http://localhost:5183/app/globals.css",
    ].join("\n");
    const presented = presentBundlerFailure(pageErrorText, tmpDir, []);
    expect(presented).toContain("tailwind.css");
    expect(presented).toContain("--no-css");
    expect(presented).not.toContain(WIN_INSTALL_ROOT);
    expect(presented).not.toContain("node_modules\\.pnpm\\postcss@");
  });

  // Conservative stripping, not blanket removal, applies on this surface too.
  it("keeps a frame pointing into the target repo's own node_modules on the page-error channel", () => {
    const pageErrorText = [
      "component harness did not become ready within timeout. Page errors:",
      "  - [vite] Internal Server Error",
      "[sass] Error: Undefined mixin.",
      "    at compileString (E:\\repositories\\twenty\\node_modules\\sass-embedded\\dist\\lib\\src\\compile.js:40:1)",
      `    at async Object.run (${WIN_INSTALL_ROOT}\\node_modules\\.pnpm\\vite@6.4.2\\node_modules\\vite\\dist\\node\\chunks\\dep-Dq2t6Dq0.js:44582:22)`,
    ].join("\n");
    const presented = presentBundlerFailure(pageErrorText, tmpDir, []);
    expect(presented).toContain("E:\\repositories\\twenty\\node_modules\\sass-embedded");
    expect(presented).not.toContain(WIN_INSTALL_ROOT);
  });
});

// M89 defect 3 (shadcn-ui): drop a stylesheet only if its own reference is unreadable.
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

// M89 defect 3: source check (no live server) that the retry composes around enterHarnessPage().
describe("M89 defect 3: analyze.ts wiring (source-level check)", () => {
  it("wraps the first enterHarnessPage() call, degrades only on stylesheetReadFailureTarget, and rebuilds with no cssFiles", () => {
    const analyzeSrc = fs.readFileSync(path.resolve("src", "pipeline/analyze.ts"), "utf-8");
    expect(analyzeSrc).toContain("try {\n      await enterHarnessPage();");
    const src = fs.readFileSync(path.resolve("src", "pipeline/phases.ts"), "utf-8");
    const start = src.indexOf("export async function recoverFromUnreadableStylesheet(");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("\n}\n", start));
    expect(block).toContain("stylesheetReadFailureTarget(message)");
    expect(block).toContain("if (!missingTarget) throw err;");
    expect(block).toContain("CSS_UNREADABLE_DROPPED_WARNING(missingTarget, droppedFiles)");
    expect(block).toContain('cssReport.layer = "unreadable"');
    expect(block).toContain("cssFiles: undefined");
    expect(block).toContain("resetSourceFingerprint()");
    expect(block).toContain("await enterHarnessPage();");
  });
});

// Item A: source-level check that analyze.ts reports via onWarning, wired to pushCurrentRunWarning.
describe("Item A: warnings-accumulator wiring (source-level check)", () => {
  it("analyze.ts reports the Stylesheets: decision line and every new runWarnings entry through options.onWarning", () => {
    const phasesSrc = fs.readFileSync(path.resolve("src", "pipeline/phases.ts"), "utf-8");
    expect(phasesSrc).toContain("const cssDecisionWarning = formatStylesheetsLine(cssReport);");
    expect(phasesSrc).toContain("options.onWarning?.(cssDecisionWarning);");
    const src = fs.readFileSync(path.resolve("src", "pipeline/analyze.ts"), "utf-8");
    const onWarningStart = src.indexOf("const onWarning = (warning: string): void => {");
    expect(onWarningStart).toBeGreaterThan(-1);
    const onWarningBlock = src.slice(onWarningStart, src.indexOf("};", onWarningStart));
    expect(onWarningBlock).toContain("options.onWarning?.(warning);");
  });

  it("cli.ts's runOne passes pushCurrentRunWarning as analyze()'s onWarning option", () => {
    const src = fs.readFileSync(path.resolve("src", "cli/main.ts"), "utf-8");
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

  // ant-design's repro: a fire-and-forget dep-optimizer scan rejects after try/catch has exited.
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
        `    at failureErrorWithLog (${WIN_INSTALL_ROOT}\\node_modules\\.pnpm\\esbuild@0.25.12\\node_modules\\esbuild\\lib\\main.js:1467:15)`,
      ].join("\n"),
    );

    setCurrentRunProjectRoot(tmpDir);
    const resolved = resolveFatalProcessError(raw, undefined);

    expect(resolved).toBeDefined();
    expect(resolved!.output).toContain("components/version/version.ts");
    expect(resolved!.output).toContain("gitignored");
    expect(resolved!.output).toContain("npm run codegen");
    expect(resolved!.output).not.toContain(WIN_INSTALL_ROOT);
    expect(resolved!.output).not.toMatch(/^\s*at\s/m);
  });

  it("passes the raw error through unchanged when no project root is known", () => {
    const raw = new Error("some unrelated rejection");
    setCurrentRunProjectRoot(undefined);
    const resolved = resolveFatalProcessError(raw, undefined);
    expect(resolved!.output).toContain("some unrelated rejection");
  });

  // Item A (M90 follow-up): accumulated warnings must reach this surface too.
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
        `    at failureErrorWithLog (${WIN_INSTALL_ROOT}\\node_modules\\.pnpm\\esbuild@0.25.12\\node_modules\\esbuild\\lib\\main.js:1467:15)`,
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

// plane's shape: the mute-readiness suspect named a sheet the compile probe had already dropped.
describe("the stylesheet a mute readiness timeout may name as its suspect", () => {
  const MUTE_TIMEOUT = "component harness did not become ready within timeout. No page errors were captured.";

  it("names the sheet that survived the probe and not the one the probe dropped", () => {
    const presented = presentBundlerFailure(MUTE_TIMEOUT, tmpDir, [
      "Stylesheets: styles/emoji.css, src/app.css (found in the project entry's own imports)",
      "styles/emoji.css did not compile ([postcss] tailwindcss: Cannot apply unknown utility class); the stylesheet was not injected and the component may render unstyled. Pass --css to name a stylesheet that compiles, or --no-css to measure without one",
    ]);

    expect(presented).toContain("src/app.css");
    expect(presented).not.toContain("stylesheet this run injected: styles/emoji.css");
  });

  it("names no stylesheet when the probe dropped every candidate, and says the probe cleared them", () => {
    const presented = presentBundlerFailure(MUTE_TIMEOUT, tmpDir, [
      "Stylesheets: styles/emoji.css (largest-stylesheet fallback, low confidence — verify with --css)",
      "styles/emoji.css did not compile ([postcss] tailwindcss: Cannot apply unknown utility class); the stylesheet was not injected and the component may render unstyled. Pass --css to name a stylesheet that compiles, or --no-css to measure without one",
    ]);

    expect(presented).toContain(MUTE_TIMEOUT);
    expect(presented).not.toContain("styles/emoji.css");
    expect(presented).toContain("compile probe");
  });

  it("treats a sheet the probe timed out on as dropped too", () => {
    const presented = presentBundlerFailure(MUTE_TIMEOUT, tmpDir, [
      "Stylesheets: styles/emoji.css (largest-stylesheet fallback, low confidence — verify with --css)",
      "styles/emoji.css did not compile within 20 s; the stylesheet was not injected and the component may render unstyled. Pass --css to name a stylesheet that compiles, or --no-css to measure without one",
    ]);

    expect(presented).not.toContain("styles/emoji.css");
    expect(presented).toContain("compile probe");
  });

  it("still names every injected sheet when the probe dropped none", () => {
    const presented = presentBundlerFailure(MUTE_TIMEOUT, tmpDir, [
      "Stylesheets: styles/emoji.css, src/app.css (found in the project entry's own imports)",
    ]);

    expect(presented).toContain("stylesheet this run injected: styles/emoji.css, src/app.css");
  });

  it("says nothing about stylesheets when the run injected none", () => {
    const presented = presentBundlerFailure(MUTE_TIMEOUT, tmpDir, [
      "Stylesheets: none found (checked the project entry, conventional filenames, and the largest stylesheet under the project)",
    ]);

    expect(presented).toBe(MUTE_TIMEOUT);
  });
});
