import { describe, it, expect, afterEach } from "vitest";
import { buildAndServe, type HarnessResult } from "../../src/harness.js";
import { discoverInteractions } from "../../src/discovery.js";
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
    () =>
      new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      ),
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

describe("H1: contenteditable", () => {
  it("discovers contenteditable div as type interaction", async () => {
    const p = await setup("./fixtures/contenteditable.tsx");
    const descriptors = await discoverInteractions(p);
    const editable = descriptors.find((d) => d.label.includes("Edit me"));
    expect(editable).toBeDefined();
    expect(editable!.type).toBe("type");
  });
});

describe("H2: deeply nested elements", () => {
  it("finds button 5+ levels deep", async () => {
    const p = await setup("./fixtures/deeply-nested.tsx");
    const descriptors = await discoverInteractions(p);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0].tagName).toBe("BUTTON");
    expect(descriptors[0].label).toContain("Deep Button");
  });
});

describe("H3: duplicate buttons get unique selectors", () => {
  it("three identical buttons each get unique selectors", async () => {
    const p = await setup("./fixtures/duplicate-buttons.tsx");
    const descriptors = await discoverInteractions(p);
    expect(descriptors).toHaveLength(3);
    const selectors = descriptors.map((d) => d.selector);
    const unique = new Set(selectors);
    expect(unique.size).toBe(3);

    for (const sel of selectors) {
      const count = await p.evaluate(
        (s: string) => document.querySelectorAll(s).length,
        sel,
      );
      expect(count).toBe(1);
    }
  });
});

describe("H4: role=button on div", () => {
  it("discovers div with role=button as click", async () => {
    const p = await setup("./fixtures/role-button-div.tsx");
    const descriptors = await discoverInteractions(p);
    const roleBtn = descriptors.find((d) => d.tagName === "DIV");
    expect(roleBtn).toBeDefined();
    expect(roleBtn!.type).toBe("click");
  });

  it("discovers span with role=link", async () => {
    const p = await setup("./fixtures/role-button-div.tsx");
    const descriptors = await discoverInteractions(p);
    const roleLink = descriptors.find((d) => d.tagName === "SPAN");
    expect(roleLink).toBeDefined();
  });
});

describe("H5: input type=hidden", () => {
  it("skips hidden input, finds visible text input", async () => {
    const p = await setup("./fixtures/hidden-input.tsx");
    const descriptors = await discoverInteractions(p);
    const inputs = descriptors.filter((d) => d.tagName === "INPUT");
    expect(inputs).toHaveLength(1);
    expect(inputs[0].inputType).toBe("text");
  });
});

describe("H7: disabled button still discovered", () => {
  it("discovers both disabled and enabled buttons", async () => {
    const p = await setup("./fixtures/disabled-button.tsx");
    const descriptors = await discoverInteractions(p);
    expect(descriptors).toHaveLength(2);
    expect(descriptors.every((d) => d.tagName === "BUTTON")).toBe(true);
  });
});

describe("H9: combobox pattern", () => {
  it("discovers combobox as type with role annotation", async () => {
    const p = await setup("./fixtures/aria-combobox.tsx");
    const descriptors = await discoverInteractions(p);
    const combo = descriptors.find((d) => d.role === "combobox");
    expect(combo).toBeDefined();
    expect(combo!.type).toBe("type");
    expect(combo!.tagName).toBe("INPUT");
  });
});

describe("H10: tree pattern", () => {
  it("discovers treeitems with tree role", async () => {
    const p = await setup("./fixtures/aria-tree.tsx");
    const descriptors = await discoverInteractions(p);
    const treeItems = descriptors.filter((d) => d.role === "tree");
    expect(treeItems.length).toBe(4);
    for (const item of treeItems) {
      expect(item.type).toBe("click");
    }
  });
});

describe("H11: label wrapping input", () => {
  it("does not double-count inputs inside labels", async () => {
    const p = await setup("./fixtures/label-wrapping.tsx");
    const descriptors = await discoverInteractions(p);
    const inputs = descriptors.filter((d) => d.tagName === "INPUT");
    expect(inputs).toHaveLength(2);
  });
});

describe("H12: keyboard-only handler", () => {
  it("element with onKeyDown (React) still discoverable via tabindex", async () => {
    const p = await setup("./fixtures/keyboard-only.tsx");
    const descriptors = await discoverInteractions(p);
    expect(descriptors.length).toBeGreaterThanOrEqual(2);
    const btn = descriptors.find((d) => d.tagName === "BUTTON");
    expect(btn).toBeDefined();
  });
});

describe("H13: 100 buttons stress test", () => {
  it("discovers all 100 buttons without timeout", async () => {
    const p = await setup("./fixtures/many-buttons.tsx");
    const descriptors = await discoverInteractions(p);
    expect(descriptors).toHaveLength(100);
    const uniqueSelectors = new Set(descriptors.map((d) => d.selector));
    expect(uniqueSelectors.size).toBe(100);
  });
});

describe("H14: renders-null component", () => {
  it("returns empty array", async () => {
    const p = await setup("./fixtures/renders-null.tsx");
    const descriptors = await discoverInteractions(p);
    expect(descriptors).toEqual([]);
  });
});
