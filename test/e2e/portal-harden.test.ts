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

describe("H1: portal with no interactive elements", () => {
  it("does not crash and discovers #root button only", async () => {
    const p = await setup("./fixtures/portal-empty.fixture.tsx");
    const descriptors = await discoverInteractions(p);

    const rootBtn = descriptors.find((d) => d.label.includes("Main"));
    expect(rootBtn).toBeDefined();

    const portalDescs = descriptors.filter((d) => d.portal === true);
    expect(portalDescs).toHaveLength(0);
  });
});

describe("H2: hidden portal content is filtered", () => {
  it("skips display:none, visibility:hidden, aria-hidden buttons in portal", async () => {
    const p = await setup("./fixtures/portal-hidden.fixture.tsx");
    const descriptors = await discoverInteractions(p);

    const labels = descriptors.map((d) => d.label);
    expect(labels.some((l) => l.includes("Visible"))).toBe(true);
    expect(labels.some((l) => l.includes("Portal Visible"))).toBe(true);

    expect(labels.some((l) => l.includes("Hidden Display"))).toBe(false);
    expect(labels.some((l) => l.includes("Hidden Visibility"))).toBe(false);
    expect(labels.some((l) => l.includes("Hidden Aria"))).toBe(false);
  });
});

describe("H3: mixed root and portal interactions", () => {
  it("discovers both root and portal interactives without duplicates", async () => {
    const p = await setup("./fixtures/portal-mixed.fixture.tsx");
    const descriptors = await discoverInteractions(p);

    const rootDescs = descriptors.filter((d) => !d.portal);
    const portalDescs = descriptors.filter((d) => d.portal === true);

    expect(rootDescs.length).toBeGreaterThanOrEqual(3);
    expect(portalDescs.length).toBeGreaterThanOrEqual(2);

    const selectors = descriptors.map((d) => d.selector);
    expect(new Set(selectors).size).toBe(selectors.length);
  });
});

describe("H4: portal form elements have correct interaction types", () => {
  it("discovers portal inputs, textarea, select, contenteditable with correct types", async () => {
    const p = await setup("./fixtures/portal-form.fixture.tsx");
    const descriptors = await discoverInteractions(p);
    const portalDescs = descriptors.filter((d) => d.portal === true);

    const textInput = portalDescs.find((d) => d.label.includes("Name") || d.selector.includes("portal-text"));
    expect(textInput).toBeDefined();
    expect(textInput!.type).toBe("type");

    const emailInput = portalDescs.find((d) => d.selector.includes("portal-email"));
    expect(emailInput).toBeDefined();
    expect(emailInput!.type).toBe("type");

    const checkbox = portalDescs.find((d) => d.selector.includes("portal-checkbox"));
    expect(checkbox).toBeDefined();
    expect(checkbox!.type).toBe("click");

    const textarea = portalDescs.find((d) => d.selector.includes("portal-textarea"));
    expect(textarea).toBeDefined();
    expect(textarea!.type).toBe("type");

    const select = portalDescs.find((d) => d.selector.includes("portal-select"));
    expect(select).toBeDefined();
    expect(select!.type).toBe("select");

    const editable = portalDescs.find((d) => d.selector.includes("portal-editable"));
    expect(editable).toBeDefined();
    expect(editable!.type).toBe("type");

    const submit = portalDescs.find((d) => d.selector.includes("portal-submit"));
    expect(submit).toBeDefined();
    expect(submit!.type).toBe("click");
  });
});

describe("H5: portal descriptors have valid selectors", () => {
  it("all portal selectors resolve to existing elements", async () => {
    const p = await setup("./fixtures/portal-mixed.fixture.tsx");
    const descriptors = await discoverInteractions(p);

    for (const d of descriptors) {
      const exists = await p.evaluate(
        (sel: string) => document.querySelector(sel) !== null,
        d.selector,
      );
      expect(exists).toBe(true);
    }
  });
});

describe("H6: many portal triggers", () => {
  it("discovers portal content from multiple triggers without timeout", async () => {
    const p = await setup("./fixtures/portal-many-triggers.fixture.tsx");
    const descriptors = await discoverInteractions(p, {
      probePortals: true,
      remount: () => remount(p),
    });

    const portalDescs = descriptors.filter((d) => d.portal === true);
    expect(portalDescs.length).toBeGreaterThanOrEqual(1);

    const triggerDescs = descriptors.filter((d) => !d.portal);
    expect(triggerDescs.length).toBe(12);
  }, 60000);
});

describe("H7: no-portal component backward compat", () => {
  it("interactive-basic produces same results with and without portal options", async () => {
    const p = await setup("./fixtures/interactive-basic.tsx");
    const without = await discoverInteractions(p);
    const withPortals = await discoverInteractions(p, {
      probePortals: true,
      remount: () => remount(p),
    });

    expect(withPortals.length).toBe(without.length);
    for (let i = 0; i < without.length; i++) {
      expect(withPortals[i].type).toBe(without[i].type);
      expect(withPortals[i].tagName).toBe(without[i].tagName);
    }
  });
});

describe("H8: portal determinism", () => {
  it("same component produces same portal descriptors across calls", async () => {
    const p = await setup("./fixtures/portal-always-open.fixture.tsx");
    const first = await discoverInteractions(p);
    const second = await discoverInteractions(p);
    expect(first).toEqual(second);
  });
});

describe("H9: portal-always-open portal flag consistency", () => {
  it("all portal elements have portal=true, all root elements don't", async () => {
    const p = await setup("./fixtures/portal-mixed.fixture.tsx");
    const descriptors = await discoverInteractions(p);

    for (const d of descriptors) {
      const isInsideRoot = await p.evaluate(
        (sel: string) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          const root = document.getElementById("root");
          return root?.contains(el) ?? false;
        },
        d.selector,
      );

      if (isInsideRoot) {
        expect(d.portal).toBeUndefined();
      } else {
        expect(d.portal).toBe(true);
      }
    }
  });
});

describe("H10: portal with link element", () => {
  it("discovers links with href inside portals", async () => {
    const p = await setup("./fixtures/portal-always-open.fixture.tsx");
    const descriptors = await discoverInteractions(p);

    const link = descriptors.find((d) => d.tagName === "A" && d.portal);
    expect(link).toBeDefined();
    expect(link!.type).toBe("click");
  });
});
