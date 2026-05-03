import { describe, it, expect, afterEach } from "vitest";
import { buildAndServe, type HarnessResult } from "../../src/harness.js";
import { discoverInteractions, type InteractionDescriptor } from "../../src/discovery.js";
import { chromium, type Browser, type Page } from "playwright";

let harness: HarnessResult | undefined;
let browser: Browser | undefined;
let page: Page | undefined;

async function setup(fixturePath: string) {
  harness = await buildAndServe(fixturePath);
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.goto(harness.url);
  await page.waitForFunction(
    () => typeof (window as any).__120fps === "object",
    { timeout: 10000 },
  );
  await page.evaluate(() => {
    (window as any).__120fps.mount({});
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  return page;
}

async function remount(p: Page) {
  await p.evaluate(() => {
    (window as any).__120fps.unmount();
    (window as any).__120fps.mount({});
  });
  await p.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

afterEach(async () => {
  if (browser) await browser.close();
  browser = undefined;
  page = undefined;
  if (harness) await harness.cleanup();
  harness = undefined;
});

describe("portal discovery e2e", () => {
  it("discovers always-open portal content outside #root", async () => {
    const p = await setup("./fixtures/portal-always-open.fixture.tsx");
    const descriptors = await discoverInteractions(p);

    const portalDescs = descriptors.filter((d) => d.portal === true);
    expect(portalDescs.length).toBeGreaterThanOrEqual(1);

    const actionBtn = portalDescs.find((d) => d.label.includes("Take Action"));
    expect(actionBtn).toBeDefined();
    expect(actionBtn!.portal).toBe(true);
  });

  it("discovers trigger-gated portal content after exercising trigger", async () => {
    const p = await setup("./fixtures/portal-modal.fixture.tsx");
    const descriptors = await discoverInteractions(p, {
      probePortals: true,
      remount: () => remount(p),
    });

    const portalDescs = descriptors.filter((d) => d.portal === true);
    expect(portalDescs.length).toBeGreaterThanOrEqual(1);

    const closeBtn = portalDescs.find((d) => d.label.includes("Close"));
    expect(closeBtn).toBeDefined();
    expect(closeBtn!.portal).toBe(true);
    expect(closeBtn!.triggeredBy).toBeDefined();
  });

  it("discovers select dropdown options in portal", async () => {
    const p = await setup("./fixtures/portal-select.fixture.tsx");
    const descriptors = await discoverInteractions(p, {
      probePortals: true,
      remount: () => remount(p),
    });

    const portalDescs = descriptors.filter((d) => d.portal === true);
    expect(portalDescs.length).toBeGreaterThanOrEqual(1);

    const options = portalDescs.filter((d) => d.role === "listbox");
    expect(options.length).toBeGreaterThanOrEqual(1);
  });

  it("discovers nested portals (popover inside modal)", async () => {
    const p = await setup("./fixtures/portal-nested.fixture.tsx");
    const descriptors = await discoverInteractions(p, {
      probePortals: true,
      remount: () => remount(p),
    });

    const portalDescs = descriptors.filter((d) => d.portal === true);
    // Should find modal content and potentially popover content
    expect(portalDescs.length).toBeGreaterThanOrEqual(2);
  });

  it("components without portals produce identical results", async () => {
    const p = await setup("./fixtures/standalone.fixture.tsx");
    const withoutPortals = await discoverInteractions(p);
    const withPortals = await discoverInteractions(p, {
      probePortals: true,
      remount: () => remount(p),
    });

    expect(withPortals).toEqual(withoutPortals);
  });

  it("does not double-count elements inside #root when walking body", async () => {
    const p = await setup("./fixtures/portal-always-open.fixture.tsx");
    const descriptors = await discoverInteractions(p);

    const selectors = descriptors.map((d) => d.selector);
    const unique = new Set(selectors);
    expect(unique.size).toBe(selectors.length);
  });

  it("filters out framework internals from body-level discovery", async () => {
    const p = await setup("./fixtures/portal-always-open.fixture.tsx");
    const descriptors = await discoverInteractions(p);

    for (const d of descriptors) {
      expect(d.tagName).not.toBe("SCRIPT");
      expect(d.tagName).not.toBe("STYLE");
      expect(d.tagName).not.toBe("LINK");
      expect(d.selector).not.toContain("vite");
    }
  });

  it("portal descriptors have valid CSS selectors", async () => {
    const p = await setup("./fixtures/portal-always-open.fixture.tsx");
    const descriptors = await discoverInteractions(p);
    const portalDescs = descriptors.filter((d) => d.portal === true);

    for (const d of portalDescs) {
      const exists = await p.evaluate(
        (sel: string) => document.querySelector(sel) !== null,
        d.selector,
      );
      expect(exists).toBe(true);
    }
  });
});
