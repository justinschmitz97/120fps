import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { unionCachedDeps } from "../../src/harness.js";

// M34: optimizeDeps.include must converge to a stable superset per project, so
// the per-component scan variation stops invalidating Vite's dep cache hash.
describe("M34: unionCachedDeps", () => {
  it("unions include with previously optimized deps, deduped and sorted", () => {
    const metadata = JSON.stringify({
      optimized: { "react-dom/client": {}, recharts: {}, react: {} },
    });
    expect(unionCachedDeps(["react", "clsx"], metadata)).toEqual([
      "clsx",
      "react",
      "react-dom/client",
      "recharts",
    ]);
  });

  it("sorts the include list even without cache metadata", () => {
    expect(unionCachedDeps(["b", "a", "b"], undefined)).toEqual(["a", "b"]);
  });

  it("ignores corrupt metadata", () => {
    expect(unionCachedDeps(["react"], "{not json")).toEqual(["react"]);
  });

  it("keeps scoped packages and subpath specifiers intact (HH3)", () => {
    const metadata = JSON.stringify({
      optimized: { "@radix-ui/react-dialog": {}, "next-themes": {} },
    });
    expect(unionCachedDeps(["react/jsx-runtime"], metadata)).toEqual([
      "@radix-ui/react-dialog",
      "next-themes",
      "react/jsx-runtime",
    ]);
  });

  it("treats an empty optimized block as no cached deps (HH6)", () => {
    expect(unionCachedDeps(["react"], JSON.stringify({ optimized: {} }))).toEqual(["react"]);
  });

  it("ignores metadata without an optimized block and never reads chunks", () => {
    const metadata = JSON.stringify({ chunks: { "chunk-ABC": {} } });
    expect(unionCachedDeps(["react"], metadata)).toEqual(["react"]);
  });
});

// M34: nothing edits files during a measurement run; the watcher's initial
// scan of a real repo saturates the fs threadpool exactly when the first
// module loads (~9s of the ~11s first navigation on a Next.js project).
describe("M34: harness server does not watch files", () => {
  it("passes watch: null to the dev server", () => {
    const src = fs.readFileSync(path.resolve("src", "harness.ts"), "utf-8");
    const serverBlock = src.slice(
      src.indexOf("server: {"),
      src.indexOf("resolve: {"),
    );
    expect(serverBlock).toContain("watch: null");
  });
});
