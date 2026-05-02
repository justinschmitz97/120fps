import { describe, it, expect, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { buildAndServe } from "../../src/harness.js";

let browser: Browser;

afterAll(async () => {
  if (browser) await browser.close();
});

// H11: Class component renders in harness
describe("H11: class component harness", () => {
  it("renders class component", async () => {
    browser = await chromium.launch({ headless: true });
    const harness = await buildAndServe("./fixtures/class-comp.tsx");
    try {
      const page = await browser.newPage();
      page.on("pageerror", () => {});
      await page.goto(harness.url);
      // Class component auto-mounted with {} — label is undefined, should still render structure
      await page.waitForSelector("div", { state: "attached", timeout: 10000 });
      const hasDiv = await page.evaluate(
        () => !!document.querySelector("div"),
      );
      expect(hasDiv).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });
});

// H12: React.FC renders in harness
describe("H12: React.FC harness", () => {
  it("renders FC component", async () => {
    if (!browser) browser = await chromium.launch({ headless: true });
    const harness = await buildAndServe("./fixtures/fc-pattern.tsx");
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

// H18: HTMLAttributes component renders
describe("H18: HTMLAttributes harness", () => {
  it("renders component extending HTMLAttributes", async () => {
    if (!browser) browser = await chromium.launch({ headless: true });
    const harness = await buildAndServe("./fixtures/html-attrs.tsx");
    try {
      const page = await browser.newPage();
      await page.goto(harness.url);
      await page.waitForSelector(".box", { state: "attached", timeout: 10000 });
      const tag = await page.evaluate(
        () => document.querySelector(".box")?.tagName,
      );
      expect(tag).toBe("DIV");
    } finally {
      await harness.cleanup();
    }
  });
});

// H24: Component that throws during auto-mount — harness should not crash permanently
describe("H24: throw-on-render harness", () => {
  it("harness survives auto-mount crash and Control API still works", async () => {
    if (!browser) browser = await chromium.launch({ headless: true });
    const harness = await buildAndServe("./fixtures/throws-on-render.tsx");
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(harness.url);

      // Wait a moment for the auto-mount crash
      await page.waitForTimeout(1000);

      // Auto-mount with {} should have thrown
      expect(errors.length).toBeGreaterThan(0);

      // But the Control API should still be available
      const hasApi = await page.evaluate(
        () => typeof (window as any).__120fps?.mount === "function",
      );
      expect(hasApi).toBe(true);

      // Re-mount with valid props should work
      await page.evaluate(() => {
        (window as any).__120fps.mount({
          data: { id: "1", name: "Test" },
        });
      });
      await page.waitForSelector(".card", { state: "attached", timeout: 5000 });
      const text = await page.textContent(".card strong");
      expect(text).toBe("Test");
    } finally {
      await harness.cleanup();
    }
  });
});

// H26: file with spaces in path
describe("H26: spaces in path harness", () => {
  it("renders component from directory with spaces", async () => {
    if (!browser) browser = await chromium.launch({ headless: true });
    const harness = await buildAndServe("./fixtures/spaced dir/spaced-comp.tsx");
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

// H27: two named exports — harness picks first one
describe("H27: two named exports harness", () => {
  it("renders the first exported component", async () => {
    if (!browser) browser = await chromium.launch({ headless: true });
    const harness = await buildAndServe("./fixtures/two-exports.tsx");
    try {
      const page = await browser.newPage();
      await page.goto(harness.url);
      await page.waitForSelector("button", { state: "attached", timeout: 10000 });
      const cls = await page.evaluate(
        () => document.querySelector("button")?.className,
      );
      // First component is PrimaryBtn — class should contain "primary"
      expect(cls).toContain("primary");
    } finally {
      await harness.cleanup();
    }
  });
});

// H28: double-wrapped component renders
describe("H28: memo(forwardRef) harness", () => {
  it("renders double-wrapped component", async () => {
    if (!browser) browser = await chromium.launch({ headless: true });
    const harness = await buildAndServe("./fixtures/double-wrap.tsx");
    try {
      const page = await browser.newPage();
      await page.goto(harness.url);
      await page.waitForSelector("button", { state: "attached", timeout: 10000 });
      const tag = await page.evaluate(
        () => document.querySelector("button")?.tagName,
      );
      expect(tag).toBe("BUTTON");
    } finally {
      await harness.cleanup();
    }
  });
});

// H30: useEffect component renders and ticks
describe("H30: useEffect harness", () => {
  it("renders component with useEffect and triggers lifecycle", async () => {
    if (!browser) browser = await chromium.launch({ headless: true });
    const harness = await buildAndServe("./fixtures/use-effect.tsx");
    try {
      const page = await browser.newPage();
      await page.goto(harness.url);
      await page.waitForSelector(".timer", { state: "attached", timeout: 10000 });

      // Read initial count
      const text1 = await page.textContent(".timer span");
      expect(text1).toContain("elapsed");

      // Wait for at least one tick and verify count increases
      await page.waitForTimeout(1500);
      const text2 = await page.textContent(".timer span");
      expect(text2).not.toBe(text1);
    } finally {
      await harness.cleanup();
    }
  });
});
