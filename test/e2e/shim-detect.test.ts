import { describe, it, expect } from "vitest";
import path from "node:path";
import { buildAndServe, scanExternalDeps } from "../../src/harness/index.js";

const HERO = path.resolve(import.meta.dirname, "../../fixtures/next-project/Hero.tsx");

describe("Next.js shim reporting", () => {
  // scanExternalDeps collapses next/image to next; shim intersection needs raw specifiers.
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

// M62: only compiled dist/shims/*.js reproduces the bug; requires `pnpm build` to have run.
describe("Next.js shim reporting against compiled dist", () => {
  it("reports shims from the built dist/harness.js output", async () => {
    const dist = await import("../../dist/harness/build.js");
    const harness = await dist.buildAndServe(HERO);
    try {
      expect(harness.nextJsShims).toEqual(["next/image", "next/link"]);
    } finally {
      await harness.cleanup();
    }
  });
});
