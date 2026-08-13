import { describe, it, expect } from "vitest";
import { expandComponentPaths, isComponentFile, type PathReader } from "../../src/cli.js";

// Injected filesystem so the contract is testable without touching disk.
function reader(tree: Record<string, "file" | "dir">): PathReader {
  return {
    exists: (p) => p in tree,
    isDirectory: (p) => tree[p] === "dir",
    walk: (root) =>
      Object.entries(tree)
        .filter(([p, kind]) => kind === "file" && p.startsWith(root.endsWith("/") ? root : root + "/"))
        .map(([p]) => p),
  };
}

const TREE: Record<string, "file" | "dir"> = {
  "src": "dir",
  "src/components": "dir",
  "src/components/ui": "dir",
  "src/components/ui/button.tsx": "file",
  "src/components/ui/button.test.tsx": "file",
  "src/components/ui/button.stories.tsx": "file",
  "src/components/ui/card.fixture.tsx": "file",
  "src/components/ui/card.tsx": "file",
  "src/components/app/panel.jsx": "file",
  "src/types.d.ts": "file",
  "src/main.tsx": "file",
  "node_modules/pkg/index.tsx": "file",
  "dist/bundle.tsx": "file",
  ".120fps-harness-ab12/entry.tsx": "file",
};

describe("m32 D1 — component file recognition", () => {
  it("accepts tsx and jsx", () => {
    expect(isComponentFile("a/button.tsx")).toBe(true);
    expect(isComponentFile("a/panel.jsx")).toBe(true);
  });

  it("rejects tests, stories, fixtures and declarations", () => {
    expect(isComponentFile("a/button.test.tsx")).toBe(false);
    expect(isComponentFile("a/button.spec.tsx")).toBe(false);
    expect(isComponentFile("a/button.stories.tsx")).toBe(false);
    expect(isComponentFile("a/card.fixture.tsx")).toBe(false);
    expect(isComponentFile("a/types.d.ts")).toBe(false);
  });

  it("rejects build and dependency directories", () => {
    expect(isComponentFile("node_modules/pkg/index.tsx")).toBe(false);
    expect(isComponentFile("dist/bundle.tsx")).toBe(false);
    expect(isComponentFile("build/x.tsx")).toBe(false);
    expect(isComponentFile(".next/x.tsx")).toBe(false);
    expect(isComponentFile(".120fps-harness-ab12/entry.tsx")).toBe(false);
  });

  it("accepts a windows-style path", () => {
    expect(isComponentFile("src\\components\\ui\\button.tsx")).toBe(true);
    expect(isComponentFile("src\\components\\ui\\button.test.tsx")).toBe(false);
  });
});

describe("m32 D1 — path expansion", () => {
  it("passes an existing file through untouched", () => {
    expect(expandComponentPaths(["src/components/ui/button.tsx"], reader(TREE)))
      .toEqual({ paths: ["src/components/ui/button.tsx"] });
  });

  it("expands a directory recursively, skipping non-components", () => {
    expect(expandComponentPaths(["src"], reader(TREE))).toEqual({
      paths: [
        "src/components/app/panel.jsx",
        "src/components/ui/button.tsx",
        "src/components/ui/card.tsx",
        "src/main.tsx",
      ],
    });
  });

  it("expands a single-segment glob without crossing directories", () => {
    expect(expandComponentPaths(["src/components/ui/*.tsx"], reader(TREE))).toEqual({
      paths: ["src/components/ui/button.tsx", "src/components/ui/card.tsx"],
    });
  });

  it("expands a double-star glob across depths", () => {
    expect(expandComponentPaths(["src/**/*.tsx"], reader(TREE))).toEqual({
      paths: ["src/components/ui/button.tsx", "src/components/ui/card.tsx", "src/main.tsx"],
    });
  });

  it("dedupes overlapping arguments", () => {
    const result = expandComponentPaths(["src", "src/components/ui/button.tsx"], reader(TREE));
    expect(result.paths.filter((p) => p.endsWith("button.tsx")).length).toBe(1);
  });

  it("is deterministic", () => {
    const a = expandComponentPaths(["src"], reader(TREE));
    const b = expandComponentPaths(["src"], reader(TREE));
    expect(a).toEqual(b);
  });

  it("keeps the specific message for a plain missing file", () => {
    const result = expandComponentPaths(["src/nope.tsx"], reader(TREE));
    expect(result.paths).toEqual([]);
    expect(result.error).toContain("File not found");
    expect(result.error).toContain("src/nope.tsx");
  });

  it("errors on a directory containing no components", () => {
    const empty = reader({ "src": "dir", "src/only": "dir" });
    expect(expandComponentPaths(["src"], empty).error).toContain("src");
  });

  it("errors on a glob that matches nothing", () => {
    expect(expandComponentPaths(["src/**/*.vue"], reader(TREE)).error).toContain("*.vue");
  });

  it("errors on a plain existing file with an unsupported extension", () => {
    const result = expandComponentPaths(["README.md"], reader({ "README.md": "file" }));
    expect(result.paths).toEqual([]);
    expect(result.error).toContain("README.md");
    expect(result.error).toContain(".tsx");
    expect(result.error).toContain(".jsx");
  });

  it("errors on a plain existing .d.ts file", () => {
    const result = expandComponentPaths(["src/types.d.ts"], reader(TREE));
    expect(result.paths).toEqual([]);
    expect(result.error).toContain("src/types.d.ts");
  });

  it("does not reach the extension check for a missing plain file", () => {
    // Existence is checked first — a missing file still gets the specific
    // "File not found" message, not the extension message.
    const result = expandComponentPaths(["src/ghost.md"], reader(TREE));
    expect(result.error).toContain("File not found");
  });
});

import { resolveReportPaths } from "../../src/cli.js";

describe("m32 D5 — --json survives expansion into many components", () => {
  it("keeps the exact path for a single component", () => {
    expect(resolveReportPaths(["src/ui/button.tsx"], "out/perf.json"))
      .toEqual(["out/perf.json"]);
  });

  it("derives per-component names beside an explicit --json path", () => {
    expect(resolveReportPaths(["src/ui/button.tsx", "src/ui/card.tsx"], "out/perf.json"))
      .toEqual(["out/perf.button.json", "out/perf.card.json"]);
  });

  it("falls back to the default naming when --json was not given", () => {
    expect(resolveReportPaths(["src/ui/button.tsx", "src/ui/card.tsx"]))
      .toEqual(["120fps-report.button.json", "120fps-report.card.json"]);
  });

  it("disambiguates same-named components from different directories", () => {
    const out = resolveReportPaths(["a/button.tsx", "b/button.tsx"]);
    expect(new Set(out).size).toBe(2);
  });

  it("keeps a directory prefix from the explicit path", () => {
    expect(resolveReportPaths(["a/x.tsx", "b/y.tsx"], "reports/run.json")[0])
      .toBe("reports/run.x.json");
  });
});
