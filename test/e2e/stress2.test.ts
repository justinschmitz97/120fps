import { describe, it, expect, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { buildAndServe } from "../../src/harness.js";

let browser: Browser;

afterAll(async () => {
  if (browser) await browser.close();
});

async function gotoAndMount(page: Page, url: string, props: any = {}) {
  await page.goto(url);
  await page.waitForFunction(() => typeof (window as any).__120fps === "object", { timeout: 10000 });
  await page.evaluate((p: any) => (window as any).__120fps.mount(p), props);
}

// H11: Class component renders in harness
describe("H11: class component harness", () => {
  it("renders class component", async () => {
    browser = await chromium.launch({ headless: true });
    const harness = await buildAndServe("./fixtures/class-comp.tsx");
    try {
      const page = await browser.newPage();
      await gotoAndMount(page, harness.url, { label: "Test" });
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
      await gotoAndMount(page, harness.url, { text: "Test" });
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
      await gotoAndMount(page, harness.url);
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

// H24: Component that throws — no auto-mount, so mount with valid props directly
describe("H24: throw-on-render harness", () => {
  it("harness loads and Control API works with valid props", async () => {
    if (!browser) browser = await chromium.launch({ headless: true });
    const harness = await buildAndServe("./fixtures/throws-on-render.tsx");
    try {
      const page = await browser.newPage();
      await page.goto(harness.url);
      await page.waitForFunction(() => typeof (window as any).__120fps === "object", { timeout: 10000 });

      const hasApi = await page.evaluate(
        () => typeof (window as any).__120fps?.mount === "function",
      );
      expect(hasApi).toBe(true);

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
      await gotoAndMount(page, harness.url, { text: "hello" });
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
      await gotoAndMount(page, harness.url, { label: "Test" });
      await page.waitForSelector("button", { state: "attached", timeout: 10000 });
      const cls = await page.evaluate(
        () => document.querySelector("button")?.className,
      );
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
      await gotoAndMount(page, harness.url, { label: "Test" });
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
      await gotoAndMount(page, harness.url);
      await page.waitForSelector(".timer", { state: "attached", timeout: 10000 });

      const text1 = await page.textContent(".timer span");
      expect(text1).toContain("elapsed");

      await page.waitForTimeout(1500);
      const text2 = await page.textContent(".timer span");
      expect(text2).not.toBe(text1);
    } finally {
      await harness.cleanup();
    }
  });
});
