import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { buildAndServe, type HarnessResult } from "../../src/harness.js";
import { FONT_SETTLE_WARNING } from "../../src/measure.js";
import { attachPageErrorCapture, type PageErrorCapture } from "../../src/page-errors.js";
import { sharedAnalyze as analyze } from "./shared-analyze.js";

let browser: Browser | undefined;

afterAll(async () => {
  if (browser) await browser.close();
});

async function getBrowser(): Promise<Browser> {
  if (!browser) browser = await chromium.launch({ headless: true });
  return browser;
}

function waitForHarness(page: Page, timeout = 20000): Promise<unknown> {
  return page.waitForFunction(
    () => typeof (window as any).__120fps === "object",
    undefined,
    { timeout },
  );
}

async function openHarness(
  harness: HarnessResult,
): Promise<{ page: Page; errors: PageErrorCapture }> {
  const page = await (await getBrowser()).newPage();
  const errors = attachPageErrorCapture(page);
  await page.goto(harness.url);
  await waitForHarness(page);
  return { page, errors };
}

async function mount(page: Page, props: Record<string, unknown>): Promise<void> {
  try {
    await page.evaluate((p) => (window as any).__120fps.mount(p), props);
  } catch (err) {
    if (!/Execution context was destroyed/.test(String(err))) throw err;
    await waitForHarness(page);
    await page.evaluate((p) => (window as any).__120fps.mount(p), props);
  }
}

function tmpJson(): string {
  return path.join(
    os.tmpdir(),
    `120fps-cssh-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
}

// H8: injection combined with a wrapper that imports its own stylesheet
describe("H8: --css alongside a wrapper stylesheet", () => {
  it("applies both, with the wrapper import last in the cascade", async () => {
    const harness = await buildAndServe("./fixtures/theme-probe.tsx", {
      wrapPath: path.resolve("fixtures/wrap-theme.tsx"),
      cssFiles: [path.resolve("fixtures/css-theme-extra.css")],
    });
    try {
      const { page } = await openHarness(harness);
      await mount(page, {});
      await page.waitForSelector(".theme-probe", { timeout: 10000 });
      const styles = await page.evaluate(() => {
        const el = document.querySelector(".theme-probe") as HTMLElement;
        return {
          color: getComputedStyle(el).color,
          background: getComputedStyle(el).backgroundColor,
        };
      });
      // wrapper stylesheet is imported after the injected one and wins `color`
      expect(styles.color).toBe("rgb(200, 100, 50)");
      // the injected stylesheet still owns properties the wrapper does not set
      expect(styles.background).toBe("rgb(9, 8, 7)");
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 120000);
});

// H10: the 5s font bound is non-fatal
describe("H10: font settle timeout", () => {
  it("warns and completes the run when a font request never answers", async () => {
    const stallServer = http.createServer(() => {
      // deliberately never responds
    });
    await new Promise<void>((resolve) => stallServer.listen(0, "127.0.0.1", resolve));
    const address = stallServer.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const cssPath = path.resolve("fixtures/css-stall/stall.css");
    fs.writeFileSync(
      cssPath,
      `@font-face { font-family: "StallProbe"; src: url("http://127.0.0.1:${port}/stall.woff2") format("woff2"); }\n` +
        `body::after { content: "stall"; font-family: "StallProbe"; }\n` +
        `.stall { color: rgb(6, 6, 6); }\n`,
    );

    const jsonPath = tmpJson();
    try {
      const report = await analyze("./fixtures/css-stall/Stall.tsx", {
        samples: 1,
        scalePoints: [1],
        skipReactAnalysis: true,
        skipDeltas: true,
        cssFiles: [cssPath],
        jsonPath,
      });
      expect(report.warnings ?? []).toContain(FONT_SETTLE_WARNING);
      expect(report.combos.length).toBeGreaterThan(0);
      expect(report.combos[0].mount.median).toBeGreaterThan(0);
      expect(report.css).toEqual({ files: ["stall.css"], autoDetected: false });
    } finally {
      fs.rmSync(cssPath, { force: true });
      fs.rmSync(jsonPath, { force: true });
      stallServer.closeAllConnections?.();
      await new Promise<void>((resolve) => stallServer.close(() => resolve()));
    }
  }, 300000);
});

// H12: @tailwindcss/vite present in the project's own node_modules,
// alongside a postcss.config.* in the same project (open question 3)
describe("H12: @tailwindcss/vite plugin path", () => {
  // M73: buildAndServe refuses a React project whose react-dom has no client
  // entry, so a fabricated project booting a real server owns a resolvable one.
  function installReactDom(projectRoot: string): void {
    const pkgDir = path.join(projectRoot, "node_modules", "react-dom");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "react-dom", version: "19.0.0", main: "index.js" }),
    );
    fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};");
    fs.writeFileSync(path.join(pkgDir, "client.js"), "module.exports = {};");
  }

  it("loads the plugin from the project and still runs the project's PostCSS config", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-twvite-"));
    const vitePluginMarker = path.join(projectRoot, "vite-plugin-ran.txt");
    const postcssMarker = path.join(projectRoot, "postcss-ran.txt");
    const pluginDir = path.join(projectRoot, "node_modules", "@tailwindcss", "vite");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "@tailwindcss/vite", version: "4.0.0", main: "index.mjs" }),
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.mjs"),
      `import fs from "node:fs";\n` +
        `export default function tailwindcss() {\n` +
        `  return { name: "fake-tailwindcss-vite", configResolved() { fs.writeFileSync(${JSON.stringify(vitePluginMarker)}, "ran"); } };\n` +
        `}\n`,
    );
    fs.writeFileSync(
      path.join(projectRoot, "postcss.config.mjs"),
      `import fs from "node:fs";\n` +
        `export default { plugins: [{ postcssPlugin: "marker", Once() { fs.writeFileSync(${JSON.stringify(postcssMarker)}, "ran"); } }] };\n`,
    );
    fs.writeFileSync(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ name: "twvite", devDependencies: { "@tailwindcss/vite": "^4" } }),
    );
    const cssPath = path.join(projectRoot, "app.css");
    fs.writeFileSync(cssPath, ".x{color:red}");
    const componentPath = path.join(projectRoot, "Comp.tsx");
    fs.writeFileSync(componentPath, "export function Comp() { return null; }\n");
    installReactDom(projectRoot);

    const harness = await buildAndServe(componentPath, { cssFiles: [cssPath] });
    try {
      expect(fs.existsSync(vitePluginMarker)).toBe(true);
      const response = await fetch(new URL("/app.css", harness.url));
      expect(response.status).toBe(200);
      expect(fs.existsSync(postcssMarker)).toBe(true);
    } finally {
      await harness.cleanup();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 120000);

  // Half-installed rather than absent: vitest exports NODE_PATH into pnpm's
  // hoisted store, so a package another fixture depends on resolves from any
  // directory in-process. A broken main fails the load deterministically, which
  // is the case the contract is about.
  it("continues without the plugin when it is listed but cannot be loaded", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-twvite-miss-"));
    fs.writeFileSync(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ name: "twvite-miss", devDependencies: { "@tailwindcss/vite": "^4" } }),
    );
    const brokenPluginDir = path.join(projectRoot, "node_modules", "@tailwindcss", "vite");
    fs.mkdirSync(brokenPluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(brokenPluginDir, "package.json"),
      JSON.stringify({ name: "@tailwindcss/vite", version: "4.0.0", main: "gone.mjs" }),
    );
    const cssPath = path.join(projectRoot, "app.css");
    fs.writeFileSync(cssPath, ".x{color:red}");
    const componentPath = path.join(projectRoot, "Comp.tsx");
    fs.writeFileSync(componentPath, "export function Comp() { return null; }\n");
    installReactDom(projectRoot);

    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: unknown }).write = (chunk: string) => {
      written.push(String(chunk));
      return true;
    };
    let harness: HarnessResult | undefined;
    try {
      harness = await buildAndServe(componentPath, { cssFiles: [cssPath] });
    } finally {
      (process.stderr as unknown as { write: unknown }).write = original;
    }
    try {
      expect(harness.url).toContain("http://localhost:");
      expect(written.filter((w) => w.includes("@tailwindcss/vite")).length).toBe(1);
    } finally {
      await harness.cleanup();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 120000);
});

// H14: syntax error inside a PostCSS-configured project
describe("H14: stylesheet syntax error", () => {
  it("reaches the user as a page error, not a bare timeout", async () => {
    const harness = await buildAndServe("./fixtures/css-tailwind/app/Card.tsx", {
      cssFiles: [path.resolve("fixtures/css-tailwind/app/syntax-error.css")],
    });
    try {
      const page = await (await getBrowser()).newPage();
      const errors = attachPageErrorCapture(page);
      await page.goto(harness.url);
      await expect(waitForHarness(page, 8000)).rejects.toThrow();
      const text = errors.errors.join("\n");
      expect(text).toContain("syntax-error.css");
      expect(text).not.toBe("");
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 120000);
});

// H15: a stylesheet referencing a font that 404s
describe("H15: unreachable font file", () => {
  it("still mounts and applies the rest of the stylesheet", async () => {
    const harness = await buildAndServe("./fixtures/css-font/app/Probe.tsx", {
      cssFiles: [path.resolve("fixtures/css-font/app/globals.css")],
    });
    try {
      const { page } = await openHarness(harness);
      await mount(page, { label: "x" });
      await page.waitForSelector(".font-probe", { timeout: 10000 });
      const color = await page.evaluate(
        () => getComputedStyle(document.querySelector(".font-probe") as HTMLElement).color,
      );
      expect(color).toBe("rgb(3, 3, 3)");
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 120000);
});

// H16: paths containing spaces
describe("H16: stylesheet path with spaces", () => {
  it("injects and applies it", async () => {
    const harness = await buildAndServe("./fixtures/spaced dir/spaced-comp.tsx", {
      cssFiles: [path.resolve("fixtures/spaced dir/spaced styles.css")],
    });
    try {
      const { page } = await openHarness(harness);
      await mount(page, { text: "hi" });
      await page.waitForSelector("span", { timeout: 10000 });
      const color = await page.evaluate(
        () => getComputedStyle(document.querySelector("span") as HTMLElement).color,
      );
      expect(color).toBe("rgb(5, 5, 5)");
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 120000);
});

// H17: the injected file is also imported by the component's own module graph
describe("H17: stylesheet already in the component graph", () => {
  it("applies once and does not error", async () => {
    const harness = await buildAndServe("./fixtures/with-css.tsx", {
      cssFiles: [path.resolve("fixtures/with-css.css")],
    });
    try {
      const { page, errors } = await openHarness(harness);
      await mount(page, { message: "hi", type: "error" });
      await page.waitForSelector(".alert", { timeout: 10000 });
      const styles = await page.evaluate(() => {
        const el = document.querySelector(".alert") as HTMLElement;
        return {
          padding: getComputedStyle(el).paddingTop,
          background: getComputedStyle(el).backgroundColor,
        };
      });
      expect(styles.padding).toBe("12px");
      expect(styles.background).toBe("rgb(248, 215, 218)");
      expect(errors.errors).toEqual([]);
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 120000);
});

// H20: Report.css survives the JSON round trip
describe("H20: report serialization", () => {
  it("writes the stylesheet block to the JSON report", async () => {
    const jsonPath = tmpJson();
    try {
      await analyze("./fixtures/css-tailwind/app/Card.tsx", {
        samples: 1,
        scalePoints: [1],
        skipReactAnalysis: true,
        skipDeltas: true,
        jsonPath,
      });
      const written = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      expect(written.css).toEqual({ files: ["app/globals.css"], autoDetected: true });
    } finally {
      fs.rmSync(jsonPath, { force: true });
    }
  }, 300000);
});
