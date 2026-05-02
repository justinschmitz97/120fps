import { describe, it, expect, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { buildAndServe } from "../../src/harness.js";

let browser: Browser;

afterAll(async () => {
  if (browser) await browser.close();
});

// H1: forwardRef component renders in harness
describe("H1: forwardRef harness", () => {
  it("renders forwardRef component", async () => {
    browser = await chromium.launch({ headless: true });
    const harness = await buildAndServe("./fixtures/forward-ref.tsx");
    try {
      const page = await browser.newPage();
      await page.goto(harness.url);
      await page.waitForSelector("input", { state: "attached", timeout: 10000 });
      const tag = await page.evaluate(
        () => document.querySelector("input")?.tagName,
      );
      expect(tag).toBe("INPUT");
    } finally {
      await harness.cleanup();
    }
  });
});

// H2: memo-wrapped component renders in harness
describe("H2: React.memo harness", () => {
  it("renders memo-wrapped component", async () => {
    if (!browser) browser = await chromium.launch({ headless: true });
    const harness = await buildAndServe("./fixtures/memo-comp.tsx");
    try {
      const page = await browser.newPage();
      await page.goto(harness.url);
      await page.waitForSelector("span", { state: "attached", timeout: 10000 });
      const tag = await page.evaluate(
        () => document.querySelector("span")?.tagName,
      );
      expect(tag).toBe("SPAN");
    } finally {
      await harness.cleanup();
    }
  });
});

// H3: default-export-only — harness imports { Tag } but file only has `export default function Tag`
describe("H3: default-export-only harness", () => {
  it("renders default-exported component", async () => {
    browser = await chromium.launch({ headless: true });
    const harness = await buildAndServe("./fixtures/default-only.tsx");
    try {
      const page = await browser.newPage();
      await page.goto(harness.url);
      await page.waitForSelector("span", { state: "attached", timeout: 10000 });
      const tag = await page.evaluate(
        () => document.querySelector("span")?.tagName,
      );
      expect(tag).toBe("SPAN");
    } finally {
      await harness.cleanup();
    }
  });
});

// H7: CSS import — Vite should handle CSS in the component
describe("H7: CSS import harness", () => {
  it("renders component that imports CSS without error", async () => {
    if (!browser) browser = await chromium.launch({ headless: true });
    const harness = await buildAndServe("./fixtures/with-css.tsx");
    try {
      const page = await browser.newPage();
      await page.goto(harness.url);
      await page.waitForSelector(".alert", { timeout: 10000 });
      const el = await page.evaluate(
        () => document.querySelector(".alert")?.tagName,
      );
      expect(el).toBe("DIV");
    } finally {
      await harness.cleanup();
    }
  });
});

// H8: relative sibling import — component imports ./helpers
describe("H8: sibling import harness", () => {
  it("renders component with sibling imports", async () => {
    if (!browser) browser = await chromium.launch({ headless: true });
    const harness = await buildAndServe("./fixtures/with-import.tsx");
    try {
      const page = await browser.newPage();
      await page.goto(harness.url);
      await page.waitForSelector("span", { timeout: 10000 });
      const text = await page.textContent("span");
      // formatPrice(0) = "$0.00", currency default "USD"
      expect(text).toContain("$");
    } finally {
      await harness.cleanup();
    }
  });
});

// H5: zero-props component renders in harness
describe("H5: zero-props harness", () => {
  it("renders component with no props", async () => {
    if (!browser) browser = await chromium.launch({ headless: true });
    const harness = await buildAndServe("./fixtures/no-props.tsx");
    try {
      const page = await browser.newPage();
      await page.goto(harness.url);
      await page.waitForSelector("hr", { state: "attached", timeout: 10000 });
      const tag = await page.evaluate(
        () => document.querySelector("hr")?.tagName,
      );
      expect(tag).toBe("HR");
    } finally {
      await harness.cleanup();
    }
  });
});

// H6: generic component — auto-mount with {} crashes because required array props are undefined.
// This is a known limitation: the harness auto-mounts with {}, but components with required
// non-primitive props (arrays, objects) crash. Mount with valid props via Control API instead.
describe("H6: generic component harness", () => {
  it("renders generic DataTable when mounted with valid props", async () => {
    if (!browser) browser = await chromium.launch({ headless: true });
    const harness = await buildAndServe("./fixtures/generic.tsx");
    try {
      const page = await browser.newPage();

      // Catch the auto-mount crash (expected — no valid props)
      page.on("pageerror", () => {});
      await page.goto(harness.url);

      // Re-mount with valid props
      await page.evaluate(() => {
        (window as any).__120fps.mount({
          data: [{ name: "Alice" }],
          columns: [{ key: "name", label: "Name" }],
        });
      });

      await page.waitForSelector("table", { state: "attached", timeout: 10000 });
      const tag = await page.evaluate(
        () => document.querySelector("table")?.tagName,
      );
      expect(tag).toBe("TABLE");
    } finally {
      await harness.cleanup();
    }
  });
});

// H9: concurrent buildAndServe — port collision or symlink race
describe("H9: concurrent harness instances", () => {
  it("runs two harnesses simultaneously without conflict", async () => {
    if (!browser) browser = await chromium.launch({ headless: true });

    const [h1, h2] = await Promise.all([
      buildAndServe("./fixtures/button.tsx"),
      buildAndServe("./fixtures/with-import.tsx"),
    ]);

    try {
      expect(h1.url).not.toBe(h2.url);

      const [p1, p2] = await Promise.all([
        browser.newPage(),
        browser.newPage(),
      ]);

      await Promise.all([p1.goto(h1.url), p2.goto(h2.url)]);

      await Promise.all([
        p1.waitForSelector("button", { timeout: 10000 }),
        p2.waitForSelector("span", { timeout: 10000 }),
      ]);

      const tag1 = await p1.evaluate(
        () => document.querySelector("button")?.tagName,
      );
      const tag2 = await p2.evaluate(
        () => document.querySelector("span")?.tagName,
      );

      expect(tag1).toBe("BUTTON");
      expect(tag2).toBe("SPAN");
    } finally {
      await Promise.all([h1.cleanup(), h2.cleanup()]);
    }
  });
});

// Error handling: nonexistent file
describe("error handling", () => {
  it("throws on nonexistent component file", async () => {
    await expect(
      buildAndServe("./fixtures/does-not-exist.tsx"),
    ).rejects.toThrow("Component file not found");
  });
});
