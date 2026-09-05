import { describe, it, expect } from "vitest";
import path from "node:path";
import { extractPropsDetailed } from "../../src/props/index.js";

const BARREL = path.resolve(__dirname, "../../fixtures/barrel-reexport");

// gutenberg-F2: entry-file-only walk reported 0 props instead of the declaring file's 32.
describe("a component reached through a re-export", () => {
  it("reads the props the declaring module declares", async () => {
    const detail = await extractPropsDetailed(path.join(BARREL, "index.tsx"));

    expect(detail.schemas.map((s) => s.name).sort()).toEqual([
      "cancelLabel",
      "confirmLabel",
      "isOpen",
      "title",
    ]);
  });

  it("names the declaring module and its line as the binding", async () => {
    const detail = await extractPropsDetailed(path.join(BARREL, "index.tsx"));

    expect(detail.targetName).toBe("ConfirmDialog");
    expect(detail.targetFile).toBe(path.join(BARREL, "component.tsx"));
    expect(detail.targetLine).toBeGreaterThan(0);
  });

  it("records no unresolved re-export when the specifier resolves", async () => {
    const detail = await extractPropsDetailed(path.join(BARREL, "index.tsx"));

    expect(detail.unresolvedReExport).toBeUndefined();
  });
});

// react-spectrum-F3: unresolved specifier must not claim extraction "may have failed".
describe("a re-export whose specifier does not resolve", () => {
  it("names the barrel and the specifier instead of a props table", async () => {
    const broken = path.join(BARREL, "broken.tsx");
    const detail = await extractPropsDetailed(broken);

    expect(detail.schemas).toEqual([]);
    expect(detail.unresolvedReExport).toEqual({
      barrel: broken,
      specifier: "@adobe/react-spectrum/ConfirmDialog",
    });
  });
});

// specs/milestones/m114-disclosures-are-true-for-runtime-styling-props-and-page-errors.md
describe("a barrel that re-exports without naming the binding", () => {
  it("follows `export { default } from` to the declaring module", async () => {
    const detail = await extractPropsDetailed(path.join(BARREL, "default-barrel.tsx"));

    expect(detail.schemas.map((s) => s.name).sort()).toEqual(["footer", "heading", "open"]);
    expect(detail.targetFile).toBe(path.join(BARREL, "drawer.tsx"));
    expect(detail.unresolvedReExport).toBeUndefined();
  });

  it("follows `export * from` to the declaring module", async () => {
    const detail = await extractPropsDetailed(path.join(BARREL, "star-barrel.tsx"));

    expect(detail.schemas.map((s) => s.name).sort()).toEqual([
      "cancelLabel",
      "confirmLabel",
      "isOpen",
      "title",
    ]);
    expect(detail.targetName).toBe("ConfirmDialog");
    expect(detail.unresolvedReExport).toBeUndefined();
  });
});
