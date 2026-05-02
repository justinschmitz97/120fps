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
  await page.evaluate(() => (window as any).__120fps.mount({}));
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  return page;
}

afterEach(async () => {
  if (browser) await browser.close();
  browser = undefined;
  page = undefined;
  if (harness) await harness.cleanup();
  harness = undefined;
});

describe("discoverInteractions e2e", () => {
  it("finds button, input, textarea, select, and link in basic component", async () => {
    const p = await setup("./fixtures/interactive-basic.tsx");
    const descriptors = await discoverInteractions(p);

    const types = descriptors.map((d) => d.type);
    expect(types).toContain("click"); // button, link
    expect(types).toContain("type"); // input, textarea
    expect(types).toContain("select"); // select

    const tags = descriptors.map((d) => d.tagName);
    expect(tags).toContain("BUTTON");
    expect(tags).toContain("INPUT");
    expect(tags).toContain("TEXTAREA");
    expect(tags).toContain("SELECT");
    expect(tags).toContain("A");
  });

  it("returns empty array for non-interactive component", async () => {
    const p = await setup("./fixtures/no-interactive.tsx");
    const descriptors = await discoverInteractions(p);
    expect(descriptors).toEqual([]);
  });

  it("discovers all input types with correct interaction types", async () => {
    const p = await setup("./fixtures/input-types.tsx");
    const descriptors = await discoverInteractions(p);

    const textInputs = descriptors.filter(
      (d) => d.tagName === "INPUT" && d.inputType && ["text", "email", "password", "search", "number"].includes(d.inputType),
    );
    for (const d of textInputs) {
      expect(d.type).toBe("type");
    }

    const checkbox = descriptors.find((d) => d.inputType === "checkbox");
    expect(checkbox).toBeDefined();
    expect(checkbox!.type).toBe("click");

    const radio = descriptors.filter((d) => d.inputType === "radio");
    expect(radio.length).toBe(2);
    for (const d of radio) {
      expect(d.type).toBe("click");
    }

    const range = descriptors.find((d) => d.inputType === "range");
    expect(range).toBeDefined();
    expect(range!.type).toBe("click");
  });

  it("discovers tab pattern with role annotations", async () => {
    const p = await setup("./fixtures/aria-tabs.tsx");
    const descriptors = await discoverInteractions(p);

    const tabs = descriptors.filter((d) => d.role === "tab");
    expect(tabs.length).toBe(3);
    for (const tab of tabs) {
      expect(tab.type).toBe("click");
      expect(tab.tagName).toBe("BUTTON");
    }
  });

  it("discovers accordion pattern", async () => {
    const p = await setup("./fixtures/aria-accordion.tsx");
    const descriptors = await discoverInteractions(p);

    const triggers = descriptors.filter((d) => d.role === "accordion");
    expect(triggers.length).toBe(2);
    for (const t of triggers) {
      expect(t.type).toBe("click");
    }
  });

  it("discovers listbox pattern", async () => {
    const p = await setup("./fixtures/aria-listbox.tsx");
    const descriptors = await discoverInteractions(p);

    const options = descriptors.filter((d) => d.role === "listbox");
    expect(options.length).toBeGreaterThanOrEqual(1);
  });

  it("discovers dialog trigger", async () => {
    const p = await setup("./fixtures/aria-dialog.tsx");
    const descriptors = await discoverInteractions(p);

    const trigger = descriptors.find((d) => d.role === "dialog");
    expect(trigger).toBeDefined();
    expect(trigger!.type).toBe("click");
  });

  it("discovers elements inside open shadow DOM", async () => {
    const p = await setup("./fixtures/shadow-dom.tsx");
    const descriptors = await discoverInteractions(p);

    const tags = descriptors.map((d) => d.tagName);
    expect(tags).toContain("BUTTON"); // both light and shadow buttons
    expect(descriptors.filter((d) => d.tagName === "BUTTON").length).toBeGreaterThanOrEqual(2);
    expect(tags).toContain("INPUT"); // shadow input
  });

  it("skips hidden elements", async () => {
    const p = await setup("./fixtures/hidden-elements.tsx");
    const descriptors = await discoverInteractions(p);

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0].label).toContain("Visible");
  });

  it("discovers tabindex elements as focusable", async () => {
    const p = await setup("./fixtures/tabindex-elements.tsx");
    const descriptors = await discoverInteractions(p);

    expect(descriptors.length).toBe(2); // tabindex=0 div and span, NOT tabindex=-1
    for (const d of descriptors) {
      expect(d.type).toBe("focus");
    }
  });

  it("discovers details/summary as click", async () => {
    const p = await setup("./fixtures/details-summary.tsx");
    const descriptors = await discoverInteractions(p);

    const summary = descriptors.find((d) => d.tagName === "SUMMARY");
    expect(summary).toBeDefined();
    expect(summary!.type).toBe("click");
  });

  it("deduplicates — same element appears once even if matched by multiple criteria", async () => {
    const p = await setup("./fixtures/aria-tabs.tsx");
    const descriptors = await discoverInteractions(p);

    // tab buttons match both as <button> and [role=tab] — should appear once per element
    const selectors = descriptors.map((d) => d.selector);
    const unique = new Set(selectors);
    expect(unique.size).toBe(selectors.length);
  });

  it("produces valid CSS selectors that resolve to the element", async () => {
    const p = await setup("./fixtures/interactive-basic.tsx");
    const descriptors = await discoverInteractions(p);

    for (const d of descriptors) {
      const exists = await p.evaluate(
        (sel: string) => document.querySelector(sel) !== null,
        d.selector,
      );
      expect(exists).toBe(true);
    }
  });

  it("returns descriptors in document order", async () => {
    const p = await setup("./fixtures/interactive-basic.tsx");
    const descriptors = await discoverInteractions(p);

    // Verify order by checking positions in DOM
    const positions = await p.evaluate((sels: string[]) => {
      const all = Array.from(document.querySelectorAll("*"));
      return sels.map((s) => {
        const el = document.querySelector(s);
        return el ? all.indexOf(el) : -1;
      });
    }, descriptors.map((d) => d.selector));

    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  it("deterministic — same call twice yields identical results", async () => {
    const p = await setup("./fixtures/interactive-basic.tsx");
    const first = await discoverInteractions(p);
    const second = await discoverInteractions(p);
    expect(first).toEqual(second);
  });
});
