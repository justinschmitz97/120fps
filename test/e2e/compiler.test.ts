import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  buildAndServe,
  reactCompilerResolutionWarning,
  REACT_COMPILER_DISABLED_WARNING,
  type HarnessResult,
} from "../../src/harness.js";
import { generateProbeEntry, hasReactWarning } from "../../src/react-profiler.js";
import { sharedAnalyze as analyze } from "./shared-analyze.js";
import { chromium, type Browser, type Page } from "playwright";

const COMPILER_PROJECT = "./fixtures/compiler-project/MemoParent.tsx";
const COMPILER_ROOT = path.resolve("fixtures/compiler-project");
const RENDER_COUNT_COMPONENT = "./fixtures/compiler-project/RenderCount.tsx";
const TAILWIND_COMPONENT = "./fixtures/compiler-tailwind/app/Card.tsx";
const TAILWIND_CSS = path.resolve("fixtures/compiler-tailwind/app/globals.css");
// Lives under the repo root, which does not declare the compiler.
const PLAIN_COMPONENT = "./fixtures/button.tsx";

// The compiler emits a cache import from react/compiler-runtime; nothing else
// in the pipeline produces it, so its presence is a direct transform signal.
const COMPILED_MARKER = "compiler-runtime";

function tmpJson(): string {
  return path.join(
    os.tmpdir(),
    `120fps-compiler-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
}

let brokenProject: string | undefined;
let browser: Browser | undefined;

afterAll(async () => {
  if (browser) await browser.close();
  if (brokenProject) fs.rmSync(brokenProject, { recursive: true, force: true });
});

// A project that declares the compiler and carries a half-installed copy of it.
// Resolution then fails deterministically; a merely absent package would still
// resolve here, because vitest exports NODE_PATH into pnpm's hoisted store.
// The project lives inside the repo so react still resolves for the harness,
// and it is built once so Vite's dep cache is warm for the measured run.
function brokenCompilerProject(): string {
  if (brokenProject) return brokenProject;
  const dir = fs.mkdtempSync(path.resolve("fixtures", "compiler-broken-"));
  brokenProject = dir;
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "compiler-broken-fixture",
      private: true,
      dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
      devDependencies: { "babel-plugin-react-compiler": "^1.0.0" },
    }),
  );
  const pkgDir = path.join(dir, "node_modules", "babel-plugin-react-compiler");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      name: "babel-plugin-react-compiler",
      version: "1.0.0",
      main: "gone.cjs",
    }),
  );
  fs.writeFileSync(
    path.join(dir, "Widget.tsx"),
    'export function Widget() {\n  return <div className="broken-widget">w</div>;\n}\n',
  );
  return dir;
}

function captureStderr(): { restore: () => string[] } {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: unknown }).write = (chunk: string) => {
    written.push(String(chunk));
    return true;
  };
  return {
    restore: () => {
      (process.stderr as unknown as { write: unknown }).write = original;
      return written;
    },
  };
}

function writeProbeEntry(harness: HarnessResult): void {
  const probeEntry = generateProbeEntry({
    componentRelative: harness.component.relative,
    componentName: harness.component.name,
    isDefaultExport: harness.component.isDefaultExport,
  });
  fs.writeFileSync(path.join(harness.harnessDir, "probe-entry.tsx"), probeEntry);
}

async function openPage(harness: HarnessResult): Promise<Page> {
  if (!browser) browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(harness.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => typeof (window as any).__120fps === "object",
    undefined,
    { timeout: 30000 },
  );
  return page;
}

// Vite's dep optimizer can force a full page reload right after the first load
// when it discovers a module outside optimizeDeps.include; that destroys the
// execution context mid-call. One retry after re-waiting for the harness.
async function mountWithRetry(page: Page, props: Record<string, unknown>): Promise<void> {
  try {
    await page.evaluate((p) => (window as any).__120fps.mount(p), props);
  } catch (err) {
    if (!/Execution context was destroyed/.test(String(err))) throw err;
    await page.waitForFunction(
      () => typeof (window as any).__120fps === "object",
      undefined,
      { timeout: 30000 },
    );
    await page.evaluate((p) => (window as any).__120fps.mount(p), props);
  }
}

function settle(page: Page): Promise<unknown> {
  return page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

function pluginNames(harness: HarnessResult): string[] {
  return (harness.server.config.plugins as ReadonlyArray<{ name: string }>).map(
    (p) => p.name,
  );
}

// agent:false keeps no socket alive, and the idle wait lets the dep-optimizer
// work a request kicks off finish: closing the server before it settles never
// resolves.
async function readModule(harness: HarnessResult, specifier: string): Promise<string> {
  const url = new URL(specifier, harness.url).href;
  const response = await new Promise<{ status: number; text: string }>(
    (resolve, reject) => {
      http
        .get(url, { agent: false }, (res) => {
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        })
        .on("error", reject);
    },
  );
  await harness.server.waitForRequestsIdle();
  expect(response.status).toBe(200);
  return response.text;
}

// --- K1/K2: detection and plugin assembly ---

describe("compiler e2e: Vite config assembly", () => {
  it("adds the react plugin for a project that declares the compiler", async () => {
    const harness = await buildAndServe(COMPILER_PROJECT);
    try {
      expect(harness.reactCompiler).toMatchObject({ detected: true, active: true });
      expect(harness.reactCompiler!.version).toBe("1.0.0");
      expect(pluginNames(harness).some((n) => n.startsWith("vite:react"))).toBe(true);
    } finally {
      await harness.cleanup();
    }
  }, 120000);

  it("carries no react plugin for a project without the compiler", async () => {
    const harness = await buildAndServe(PLAIN_COMPONENT);
    try {
      expect(harness.reactCompiler).toEqual({ detected: false, active: false });
      expect(pluginNames(harness).some((n) => n.startsWith("vite:react"))).toBe(false);
    } finally {
      await harness.cleanup();
    }
  }, 120000);

  it("carries no react plugin when the compiler is disabled by flag", async () => {
    const harness = await buildAndServe(COMPILER_PROJECT, { reactCompiler: false });
    try {
      expect(harness.reactCompiler).toMatchObject({ detected: true, active: false });
      expect(pluginNames(harness).some((n) => n.startsWith("vite:react"))).toBe(false);
    } finally {
      await harness.cleanup();
    }
  }, 120000);

  it("rejects a forced transform the project cannot resolve", async () => {
    const project = brokenCompilerProject();
    await expect(
      buildAndServe(path.join(project, "Widget.tsx"), { reactCompiler: true }),
    ).rejects.toThrow(`babel-plugin-react-compiler not found in ${project}`);
    expect(fs.readdirSync(project).some((e) => e.startsWith(".120fps-harness-"))).toBe(
      false,
    );
  }, 60000);

  it("warns once and continues without the transform when resolution fails", async () => {
    const project = brokenCompilerProject();
    const capture = captureStderr();
    let harness: HarnessResult | undefined;
    let stderr: string[];
    try {
      harness = await buildAndServe(path.join(project, "Widget.tsx"));
    } finally {
      stderr = capture.restore();
    }
    try {
      expect(harness!.reactCompiler).toEqual({
        detected: true,
        active: false,
        warning: reactCompilerResolutionWarning(project),
      });
      expect(pluginNames(harness!).some((n) => n.startsWith("vite:react"))).toBe(false);
      const compilerWarnings = stderr.filter((line) =>
        line.includes("babel-plugin-react-compiler"),
      );
      expect(compilerWarnings.length).toBe(1);
      expect(compilerWarnings[0]).toContain(project);

      // Loading the page once fills Vite's dep cache for this project, so the
      // measured run below cannot hit the optimizer's first-load full reload.
      const page = await openPage(harness!);
      await mountWithRetry(page, {});
      await page.close();
    } finally {
      await harness!.cleanup();
    }
  }, 120000);
});

// --- K2: the transform actually runs ---

describe("compiler e2e: served modules", () => {
  it("compiles the component module when active", async () => {
    const harness = await buildAndServe(COMPILER_PROJECT);
    try {
      const code = await readModule(harness, "/MemoParent.tsx");
      expect(code).toContain(COMPILED_MARKER);
    } finally {
      await harness.cleanup();
    }
  }, 120000);

  it("leaves the component module untransformed when inactive", async () => {
    const harness = await buildAndServe(COMPILER_PROJECT, { reactCompiler: false });
    try {
      const code = await readModule(harness, "/MemoParent.tsx");
      expect(code).not.toContain(COMPILED_MARKER);
    } finally {
      await harness.cleanup();
    }
  }, 120000);

  // The probe's own synthetic provider assigns to window during render, which
  // the compiler refuses to compile, so it carries no cache import. What the
  // contract needs is that probe-entry.tsx goes through the same babel pipeline
  // as every other module: the Fast Refresh markers only @vitejs/plugin-react
  // emits are the evidence, and the component it imports is compiled above.
  it("runs the React probe entry through the transform pipeline", async () => {
    const active = await buildAndServe(COMPILER_PROJECT);
    try {
      writeProbeEntry(active);
      expect(await readModule(active, "probe-entry.tsx")).toContain("$RefreshSig$");
    } finally {
      await active.cleanup();
    }

    const inactive = await buildAndServe(COMPILER_PROJECT, { reactCompiler: false });
    try {
      writeProbeEntry(inactive);
      expect(await readModule(inactive, "probe-entry.tsx")).not.toContain("$RefreshSig$");
    } finally {
      await inactive.cleanup();
    }
  }, 180000);
});

// --- K4: the memoization the reinterpretation rests on ---

describe("compiler e2e: automatic memoization", () => {
  // Counts child renders caused by one same-props rerender. The mount is done
  // first and the counter reset afterwards, so the dep-optimizer reload Vite can
  // trigger on the first load cannot land inside the measured window.
  async function countChildRenders(compilerActive: boolean): Promise<number> {
    const harness = await buildAndServe(RENDER_COUNT_COMPONENT, {
      ...(compilerActive ? {} : { reactCompiler: false }),
    });
    try {
      expect(harness.reactCompiler!.active).toBe(compilerActive);
      const page = await openPage(harness);
      await mountWithRetry(page, { label: "x" });
      await settle(page);
      expect(await page.evaluate(() => (window as any).__childRenders ?? 0)).toBeGreaterThan(0);

      await page.evaluate(() => {
        (window as any).__childRenders = 0;
      });
      await page.evaluate(() => (window as any).__120fps.rerender({ label: "x" }));
      await settle(page);
      const renders = await page.evaluate(() => (window as any).__childRenders ?? 0);
      await page.close();
      return renders;
    } finally {
      await harness.cleanup();
    }
  }

  it("re-renders the child on a same-props rerender without the transform", async () => {
    expect(await countChildRenders(false)).toBeGreaterThan(0);
  }, 180000);

  it("skips the child on a same-props rerender with the transform", async () => {
    expect(await countChildRenders(true)).toBe(0);
  }, 180000);
});

// --- K2: coexistence with M25's Tailwind plugin ---

describe("compiler e2e: coexistence with @tailwindcss/vite", () => {
  it("keeps both plugins when the project uses Tailwind and the compiler", async () => {
    const harness = await buildAndServe(TAILWIND_COMPONENT, { cssFiles: [TAILWIND_CSS] });
    try {
      const names = pluginNames(harness);
      expect(names.some((n) => n.includes("tailwindcss"))).toBe(true);
      expect(names.some((n) => n.startsWith("vite:react"))).toBe(true);
      expect(harness.reactCompiler).toMatchObject({ detected: true, active: true });

      const css = await readModule(harness, "/app/globals.css");
      expect(css).toContain("#654321");

      const code = await readModule(harness, "/app/Card.tsx");
      expect(code).toContain(COMPILED_MARKER);
    } finally {
      await harness.cleanup();
    }
  }, 180000);

  it("keeps the Tailwind plugin when the compiler is disabled", async () => {
    const harness = await buildAndServe(TAILWIND_COMPONENT, {
      cssFiles: [TAILWIND_CSS],
      reactCompiler: false,
    });
    try {
      const names = pluginNames(harness);
      expect(names.some((n) => n.includes("tailwindcss"))).toBe(true);
      expect(names.some((n) => n.startsWith("vite:react"))).toBe(false);
    } finally {
      await harness.cleanup();
    }
  }, 180000);
});

// --- K4/K5/K6: full pipeline ---

describe("compiler e2e: full pipeline", () => {
  const baselinePath = path.join(COMPILER_ROOT, "120fps-baseline.json");

  it("reports the disabled compiler and omits it from the baseline", async () => {
    const jsonPath = tmpJson();
    fs.rmSync(baselinePath, { force: true });
    try {
      const report = await analyze(COMPILER_PROJECT, {
        samples: 2,
        reactCompiler: false,
        matrixMode: false,
        curveMode: false,
        skipDeltas: true,
        skipAutoScale: true,
        saveBaseline: true,
        jsonPath,
      });

      expect(report.reactCompiler).toEqual({ active: false, detected: true });
      expect(report.warnings ?? []).toContain(REACT_COMPILER_DISABLED_WARNING);

      const opts = report.combos[0].reactOptimizations!;
      expect(opts.compilerActive).toBeUndefined();
      expect(hasReactWarning(opts)).toBe(false);

      const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf-8"));
      // M45: entries are keyed by component and environment slot.
      const entry = baseline.entries[
        Object.keys(baseline.entries).find((k: string) => k.startsWith("./MemoParent.tsx#"))!
      ];
      expect("reactCompiler" in entry.env).toBe(false);
    } finally {
      fs.rmSync(baselinePath, { force: true });
      fs.rmSync(jsonPath, { force: true });
    }
  }, 600000);

  it("marks every combo compiled and records it in the baseline", async () => {
    const jsonPath = tmpJson();
    fs.rmSync(baselinePath, { force: true });
    try {
      const report = await analyze(COMPILER_PROJECT, {
        samples: 2,
        matrixMode: false,
        curveMode: false,
        skipDeltas: true,
        skipAutoScale: true,
        saveBaseline: true,
        jsonPath,
      });

      expect(report.reactCompiler).toEqual({
        active: true,
        detected: true,
        version: "1.0.0",
      });
      expect(report.warnings ?? []).not.toContain(REACT_COMPILER_DISABLED_WARNING);
      expect(report.combos.length).toBeGreaterThan(0);
      for (const combo of report.combos) {
        expect(combo.reactOptimizations!.compilerActive).toBe(true);
        expect(hasReactWarning(combo.reactOptimizations!)).toBe(false);
      }

      const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf-8"));
      // M45: entries are keyed by component and environment slot.
      const entry = baseline.entries[
        Object.keys(baseline.entries).find((k: string) => k.startsWith("./MemoParent.tsx#"))!
      ];
      expect(entry.env.reactCompiler).toBe(true);
    } finally {
      fs.rmSync(baselinePath, { force: true });
      fs.rmSync(jsonPath, { force: true });
    }
  }, 600000);

  it("carries the resolution warning into the report and keeps measuring", async () => {
    const project = brokenCompilerProject();
    const jsonPath = tmpJson();
    const capture = captureStderr();
    try {
      const report = await analyze(path.join(project, "Widget.tsx"), {
        samples: 2,
        matrixMode: false,
        curveMode: false,
        skipDeltas: true,
        skipAutoScale: true,
        skipReactAnalysis: true,
        jsonPath,
      });
      expect(report.reactCompiler).toEqual({ active: false, detected: true });
      expect(report.warnings ?? []).toContain(reactCompilerResolutionWarning(project));
      expect(report.warnings ?? []).not.toContain(REACT_COMPILER_DISABLED_WARNING);
      expect(report.combos[0].mount.median).toBeGreaterThan(0);
    } finally {
      capture.restore();
      fs.rmSync(jsonPath, { force: true });
    }
  }, 300000);
});
