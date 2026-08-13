import { describe, it, expect, afterAll } from "vitest";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import {
  buildAndServe,
  detectProjectTransforms,
  stripServerHooks,
  SUPPORTED_TRANSFORM_PLUGINS,
} from "../../src/harness.js";
import { attachPageErrorCapture } from "../../src/page-errors.js";

let browser: Browser | undefined;

afterAll(async () => {
  if (browser) await browser.close();
});

const PROJECT = path.resolve("fixtures/transform-project");

async function mountIn(componentPath: string, options: Parameters<typeof buildAndServe>[1] = {}) {
  browser ??= await chromium.launch({ headless: true });
  const harness = await buildAndServe(componentPath, options);
  const page = await browser.newPage();
  const errors = attachPageErrorCapture(page);
  await page.goto(harness.url, { waitUntil: "domcontentloaded" });
  await page
    .waitForFunction(() => typeof (window as any).__120fps === "object", undefined, { timeout: 20000 })
    .catch(() => undefined);
  return { page, harness, errors };
}

// C1 — detection reads the project's own manifest.
describe("m48 C1 — transform detection", () => {
  it("finds the plugins the fixture project declares", () => {
    const codes = detectProjectTransforms(PROJECT).map((t) => t.code).sort();
    expect(codes).toEqual(["svgr", "vanilla-extract"]);
  });

  it("finds none in a project that declares none", () => {
    expect(detectProjectTransforms(path.resolve("fixtures/m42-server"))).toEqual([]);
  });

  it("finds none when the manifest is unreadable", () => {
    expect(detectProjectTransforms(path.resolve("does-not-exist"))).toEqual([]);
  });

  it("keeps every supported entry addressable by its recognizer code", () => {
    for (const entry of SUPPORTED_TRANSFORM_PLUGINS) {
      expect(entry.code).toMatch(/^[a-z-]+$/);
      expect(entry.packageName.length).toBeGreaterThan(0);
    }
  });
});

// C2 — server hooks never reach the harness's server.
describe("m48 C2 — hook stripping", () => {
  it("removes the hooks that would reach into the harness server", () => {
    const stripped = stripServerHooks({
      name: "p",
      transform: () => undefined,
      configureServer: () => undefined,
      handleHotUpdate: () => undefined,
      hotUpdate: () => undefined,
      configurePreviewServer: () => undefined,
    }) as Record<string, unknown>;

    expect(stripped.transform).toBeTypeOf("function");
    expect(stripped.configureServer).toBeUndefined();
    expect(stripped.handleHotUpdate).toBeUndefined();
    expect(stripped.hotUpdate).toBeUndefined();
    expect(stripped.configurePreviewServer).toBeUndefined();
  });

  it("leaves a plugin without those hooks untouched", () => {
    const plugin = { name: "p", transform: () => undefined };
    expect(stripServerHooks(plugin)).toEqual(plugin);
  });

  it("passes non-objects through", () => {
    expect(stripServerHooks(null)).toBe(null);
    expect(stripServerHooks(undefined)).toBe(undefined);
  });
});

// C3 — the spike: do these plugins actually compile in the harness?
describe("m48 C3 — the passthrough compiles real transforms", () => {
  it("SVGR: an .svg?react import mounts as a component", async () => {
    const { page, harness, errors } = await mountIn(
      path.join(PROJECT, "app/SvgrCard.tsx"),
    );
    try {
      expect(errors.errors.join("\n")).not.toContain("Failed to resolve import");
      await page.evaluate(() => (window as any).__120fps.mount({ label: "x" }));
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
      // The SVG became a real element, not a failed import.
      expect(await page.locator("svg[data-testid=icon]").count()).toBe(1);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 120000);

  it("vanilla-extract: a .css.ts stylesheet applies real styles", async () => {
    const { page, harness, errors } = await mountIn(path.join(PROJECT, "app/VeCard.tsx"));
    try {
      expect(errors.errors.join("\n")).not.toContain("Failed to resolve import");
      await page.evaluate(() => (window as any).__120fps.mount({ label: "y" }));
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
      const style = await page.evaluate(() => {
        const el = document.querySelector("[data-testid=ve-card]") as HTMLElement;
        return el ? getComputedStyle(el).backgroundColor : "";
      });
      // The style only exists if the plugin compiled styles.css.ts.
      expect(style).toBe("rgb(18, 52, 86)");
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 120000);

  it("--no-transforms measures without them, and the component fails visibly", async () => {
    const { page, harness } = await mountIn(path.join(PROJECT, "app/VeCard.tsx"), {
      noTransforms: true,
    });
    try {
      const style = await page
        .evaluate(() => {
          const el = document.querySelector("[data-testid=ve-card]") as HTMLElement;
          return el ? getComputedStyle(el).backgroundColor : "";
        })
        .catch(() => "");
      // Without the plugin the styles cannot have been applied.
      expect(style).not.toBe("rgb(18, 52, 86)");
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 120000);
});
