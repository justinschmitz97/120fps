import { describe, it, expect } from "vitest";
import path from "node:path";
import { extractPropsDetailed } from "../../src/props/index.js";

const BARREL = path.resolve(__dirname, "../../fixtures/barrel-reexport");

// gutenberg-F2: `src/confirm-dialog/index.tsx` re-exports the component its
// sibling declares, and the entry-file-only candidate walk reported zero props
// for a component whose declaring file prints 32.

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

// react-spectrum-F3: a shim whose specifier does not resolve printed
// ZERO_PROPS_WARNING, whose "extraction may have failed" clause was false for a
// cause the filesystem decides.

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

// M114 (review B-major): `export { default } from "./x"` and `export * from
// "./x"` name no PascalCase binding in the barrel's own text, so the export
// scan yielded nothing and the follow gave up on a barrel the filesystem
// resolves.

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
