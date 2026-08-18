import { describe, it, expect } from "vitest";
import path from "node:path";
import { buildAndServe, scanExternalDeps } from "../../src/harness.js";

const HERO = path.resolve(import.meta.dirname, "../../fixtures/next-project/Hero.tsx");

describe("Next.js shim reporting", () => {
  // scanExternalDeps collapses "next/image" to "next" for optimizeDeps, so the
  // shim intersection has to run against the raw specifiers.
  it("collects raw specifiers alongside package names", () => {
    const specifiers = new Set<string>();
    const pkgs = scanExternalDeps(HERO, path.dirname(HERO), [], specifiers);

    expect([...specifiers].sort()).toEqual(["next/image", "next/link"]);
    expect(pkgs).not.toContain("next");
  });

  it("reports the shimmed modules the component actually imports", async () => {
    const harness = await buildAndServe(HERO);
    try {
      expect(harness.nextJsShims).toEqual(["next/image", "next/link"]);
    } finally {
      await harness.cleanup();
    }
  });

  it("reports no shims when they are disabled", async () => {
    const harness = await buildAndServe(HERO, { noShims: true });
    try {
      expect(harness.nextJsShims).toBeUndefined();
    } finally {
      await harness.cleanup();
    }
  });
});

// M62: the block above runs harness.ts through vitest's TS transform, where
// import.meta.dirname resolves to src/shims/: a directory holding only
// .ts sources. A shim alias whose replacement never exists as a file cannot
// reproduce the M62 bug: resolveLocalImport fails to resolve it locally and
// the specifier falls through to the plain external-specifier branch, which
// already worked before the fix. Only the compiled dist/shims/*.js: what
// `npx 120fps` actually runs: exercises the "alias resolves to a real
// local file" path that was broken. Requires `pnpm build` to have run.
describe("Next.js shim reporting against compiled dist", () => {
  it("reports shims from the built dist/harness.js output", async () => {
    const dist = await import("../../dist/harness.js");
    const harness = await dist.buildAndServe(HERO);
    try {
      expect(harness.nextJsShims).toEqual(["next/image", "next/link"]);
    } finally {
      await harness.cleanup();
    }
  });
});
