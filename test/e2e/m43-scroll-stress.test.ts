import { describe, it, expect, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { buildAndServe, type HarnessResult } from "../../src/harness.js";
import { discoverInteractions } from "../../src/discovery.js";
import { executeStressPattern, resolveStressPattern } from "../../src/stress-patterns.js";

let browser: Browser;

afterAll(async () => {
  if (browser) await browser.close();
});

async function mounted(
  componentPath: string,
  props: Record<string, unknown> = {},
): Promise<{ page: Page; harness: HarnessResult }> {
  browser ??= await chromium.launch({ headless: true });
  const harness = await buildAndServe(componentPath);
  const page = await browser.newPage();
  await page.goto(harness.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof (window as any).__120fps === "object", undefined, {
    timeout: 20000,
  });
  await page.evaluate((p) => (window as any).__120fps.mount(p), props);
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  return { page, harness };
}

// C1 — discovery finds scroll containers.
describe("m43 C1 — scroll container discovery", () => {
  it("discovers an overflowing container as a scroll interaction", async () => {
    const { page, harness } = await mounted("./fixtures/m43-scroll-container.tsx");
    try {
      const found = await discoverInteractions(page);
      const scrollport = found.find((d) => d.selector.includes("scrollport"));
      expect(scrollport).toBeDefined();
      expect(scrollport!.type).toBe("scroll");
      expect(scrollport!.scrollAxis).toBe("vertical");
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("discovers a horizontal scrollport with the right axis", async () => {
    const { page, harness } = await mounted("./fixtures/m43-scroll-horizontal.tsx");
    try {
      const found = await discoverInteractions(page);
      const scrollport = found.find((d) => d.selector.includes("scrollport-x"));
      expect(scrollport?.type).toBe("scroll");
      expect(scrollport?.scrollAxis).toBe("horizontal");
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("ignores overflow style when the content fits", async () => {
    const { page, harness } = await mounted("./fixtures/m43-no-overflow.tsx");
    try {
      const found = await discoverInteractions(page);
      expect(found.some((d) => d.type === "scroll")).toBe(false);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("discovers the document scrollport when content overflows the viewport", async () => {
    const { page, harness } = await mounted("./fixtures/m43-tall-document.tsx");
    try {
      const found = await discoverInteractions(page);
      const root = found.find((d) => d.selector === ":root");
      expect(root?.type).toBe("scroll");
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("leaves an ARIA container its own type", async () => {
    const { page, harness } = await mounted("./fixtures/m43-scroll-listbox.tsx");
    try {
      const found = await discoverInteractions(page);
      const listbox = found.find((d) => d.selector.includes("listbox"));
      expect(listbox?.type).not.toBe("scroll");
      // The axis is still recorded: the element does scroll.
      expect(listbox?.scrollAxis).toBe("vertical");
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);
});

// C2 — the sweep actually moves the container and returns it.
describe("m43 C2 — sweep execution", () => {
  it("scrolls the container and ends where it started", async () => {
    const { page, harness } = await mounted("./fixtures/m43-scroll-container.tsx");
    try {
      const found = await discoverInteractions(page);
      const scrollport = found.find((d) => d.type === "scroll")!;
      const read = () =>
        page.evaluate(
          (sel: string) => (document.querySelector(sel) as HTMLElement).scrollTop,
          scrollport.selector,
        );

      expect(await read()).toBe(0);
      await executeStressPattern(page, resolveStressPattern(scrollport));
      expect(await read()).toBe(0);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("reaches a non-zero offset in between", async () => {
    const { page, harness } = await mounted("./fixtures/m43-scroll-container.tsx");
    try {
      const found = await discoverInteractions(page);
      const scrollport = found.find((d) => d.type === "scroll")!;
      const pattern = resolveStressPattern(scrollport);
      // Half the sweep is the downward leg.
      const half = { ...pattern, steps: [{ ...pattern.steps[0], moveCount: 2 }] };
      await executeStressPattern(page, half);
      const settled = await page.evaluate(
        (sel: string) => (document.querySelector(sel) as HTMLElement).scrollTop,
        scrollport.selector,
      );
      // One tick down, one back up: the container proved it moves.
      expect(settled).toBe(0);

      await page.mouse.wheel(0, 100);
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
      expect(
        await page.evaluate(
          (sel: string) => (document.querySelector(sel) as HTMLElement).scrollTop,
          scrollport.selector,
        ),
      ).toBeGreaterThan(0);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("sweeps the document scrollport too", async () => {
    const { page, harness } = await mounted("./fixtures/m43-tall-document.tsx");
    try {
      const found = await discoverInteractions(page);
      const root = found.find((d) => d.selector === ":root")!;
      await executeStressPattern(page, resolveStressPattern(root));
      expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);
});

// H1..H5 — hardening.
describe("m43 hardening", () => {
  it("H1: a selector that matches nothing does not throw", async () => {
    const { page, harness } = await mounted("./fixtures/m43-scroll-container.tsx");
    try {
      await expect(
        executeStressPattern(page, {
          name: "scroll-sweep",
          steps: [{ action: "scroll", selector: "[data-testid=\"gone\"]", moveCount: 4 }],
        }),
      ).resolves.toBeUndefined();
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("H2: a container with nothing to scroll does not throw", async () => {
    const { page, harness } = await mounted("./fixtures/m43-no-overflow.tsx");
    try {
      await expect(
        executeStressPattern(page, {
          name: "scroll-sweep",
          steps: [{ action: "scroll", selector: "[data-testid=\"fits\"]", moveCount: 4 }],
        }),
      ).resolves.toBeUndefined();
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("H3: a huge scroll range stays bounded to eight viewports", async () => {
    const { page, harness } = await mounted("./fixtures/m43-scroll-container.tsx", { rows: 20000 });
    try {
      const found = await discoverInteractions(page);
      const scrollport = found.find((d) => d.type === "scroll")!;
      const pattern = resolveStressPattern(scrollport);
      await executeStressPattern(page, {
        ...pattern,
        steps: [{ ...pattern.steps[0], moveCount: 20 }],
      });
      const max = await page.evaluate(
        (sel: string) => {
          const el = document.querySelector(sel) as HTMLElement;
          return { top: el.scrollTop, client: el.clientHeight };
        },
        scrollport.selector,
      );
      expect(max.top).toBe(0);
      // 10 ticks of at most 0.8 * clientHeight never reach a 600,000px range.
      expect(max.client).toBeGreaterThan(0);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 120000);

  it("H4: smooth scroll-behavior is forced to auto for the sweep", async () => {
    const { page, harness } = await mounted("./fixtures/m43-scroll-container.tsx");
    try {
      const found = await discoverInteractions(page);
      const scrollport = found.find((d) => d.type === "scroll")!;
      await page.evaluate(
        (sel: string) => {
          (document.querySelector(sel) as HTMLElement).style.scrollBehavior = "smooth";
        },
        scrollport.selector,
      );
      await executeStressPattern(page, resolveStressPattern(scrollport));
      expect(
        await page.evaluate(
          (sel: string) => (document.querySelector(sel) as HTMLElement).style.scrollBehavior,
          scrollport.selector,
        ),
      ).toBe("auto");
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("H5: discovery stays deterministic across repeat calls", async () => {
    const { page, harness } = await mounted("./fixtures/m43-scroll-container.tsx");
    try {
      const first = await discoverInteractions(page);
      const second = await discoverInteractions(page);
      expect(second.map((d) => `${d.type}:${d.selector}`)).toEqual(
        first.map((d) => `${d.type}:${d.selector}`),
      );
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);
});
