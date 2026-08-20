import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  expandComponentPaths,
  isComponentFile,
  hasComponentShape,
  NO_COMPONENT_EXPORT_ERROR,
  type PathReader,
} from "../../src/cli.js";

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

describe("component file recognition", () => {
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

// M77: `.ts`/`.js` are now legal extensions, gated by hasComponentShape
// rather than accepted on extension alone. `.tsx`/`.jsx`/`.vue` short-circuit
// true with no content read (asserted implicitly above: those tests use
// fake, non-existent paths and still pass), so only the new `.ts`/`.js`
// branch needs real files on disk.
describe("the .js/.ts entry gate (M77)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-cli-gate-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(name: string, content: string): string {
    const full = path.join(tmpDir, name);
    fs.writeFileSync(full, content);
    return full;
  }

  it("accepts a .js file with a default-exported PascalCase function containing JSX", () => {
    const file = write("Button.js", "export default function Button() { return <div/>; }\n");
    expect(isComponentFile(file)).toBe(true);
  });

  it("accepts a .ts file with a PascalCase named export and zero JSX literals (factory-call shape)", () => {
    const file = write("tabs.ts", "export function TabsRoot() { return {}; }\n");
    expect(isComponentFile(file)).toBe(true);
  });

  it("rejects a .js file with only camelCase exports", () => {
    const file = write("utils.js", "export function helper() { return 1; }\n");
    expect(isComponentFile(file)).toBe(false);
  });

  it("still rejects a .d.ts file, unaffected by the .ts widening", () => {
    const file = write("types.d.ts", "export type X = 1;\n");
    expect(isComponentFile(file)).toBe(false);
  });

  describe("hasComponentShape", () => {
    it("returns true for .tsx/.jsx/.vue without reading the file", () => {
      expect(hasComponentShape(path.join(tmpDir, "does-not-exist.tsx"))).toBe(true);
      expect(hasComponentShape(path.join(tmpDir, "does-not-exist.jsx"))).toBe(true);
      expect(hasComponentShape(path.join(tmpDir, "does-not-exist.vue"))).toBe(true);
    });

    it("reads a .js/.ts file's exports to decide", () => {
      const component = write("Card.js", "export function Card() { return null; }\n");
      const utility = write("format.js", "export const formatDate = () => '';\n");
      expect(hasComponentShape(component)).toBe(true);
      expect(hasComponentShape(utility)).toBe(false);
    });
  });

  describe("expandComponentPaths: NO_COMPONENT_EXPORT_ERROR", () => {
    it("errors on an explicit .js path with no component export", () => {
      const file = write("utils.js", "export function helper() { return 1; }\n");
      const fsReader: PathReader = {
        exists: (p) => p === file,
        isDirectory: () => false,
        walk: () => [],
      };
      const result = expandComponentPaths([file], fsReader);
      expect(result.paths).toEqual([]);
      expect(result.error).toBe(NO_COMPONENT_EXPORT_ERROR(file));
    });

    it("accepts an explicit .ts path with a component export", () => {
      const file = write("tabs.ts", "export function TabsRoot() { return {}; }\n");
      const fsReader: PathReader = {
        exists: (p) => p === file,
        isDirectory: () => false,
        walk: () => [],
      };
      const result = expandComponentPaths([file], fsReader);
      expect(result.error).toBeUndefined();
      expect(result.paths).toEqual([file]);
    });

    it("directory expansion matches only the real .js component, ignoring camelCase utility files", () => {
      const component = write("Button.js", "export default function Button() { return null; }\n");
      write("helpers.js", "export function helper() { return 1; }\n");
      write("format.js", "export const formatDate = () => '';\n");
      const fsReader: PathReader = {
        exists: (p) => p === tmpDir,
        isDirectory: (p) => p === tmpDir,
        walk: () => [component, path.join(tmpDir, "helpers.js"), path.join(tmpDir, "format.js")],
      };
      const result = expandComponentPaths([tmpDir], fsReader);
      expect(result.error).toBeUndefined();
      expect(result.paths).toEqual([component]);
    });
  });
});

describe("path expansion", () => {
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
    // Existence is checked first: a missing file still gets the specific
    // "File not found" message, not the extension message.
    const result = expandComponentPaths(["src/ghost.md"], reader(TREE));
    expect(result.error).toContain("File not found");
  });
});

// nodePathReader().walk resolves its root with path.resolve before recursing
// (src/cli.ts:1171), so every path it returns is absolute — unlike the
// relative-path fixture above. A fake reader built the same way reproduces
// the production shape and is the only way to exercise M67's fix.
describe("path expansion against an absolute-path filesystem", () => {
  function absoluteReader(relativeFiles: string[]): PathReader {
    const absFiles = relativeFiles.map((f) => path.resolve(f));
    return {
      exists: () => false,
      isDirectory: () => false,
      walk: (root) => {
        const absRoot = path.resolve(root);
        return absFiles.filter((f) => f.startsWith(absRoot + path.sep));
      },
    };
  }

  const FILES = [
    "src/components/ui/button.tsx",
    "src/components/ui/card.tsx",
    "src/main.tsx",
    "packages/ui/Button.tsx",
    "packages/ui/Card.tsx",
  ];

  it("matches a rooted glob against absolutely-walked paths", () => {
    const result = expandComponentPaths(["src/**/*.tsx"], absoluteReader(FILES));
    expect(result.error).toBeUndefined();
    expect(result.paths.slice().sort()).toEqual(
      ["src/components/ui/button.tsx", "src/components/ui/card.tsx", "src/main.tsx"]
        .map((p) => path.resolve(p))
        .sort(),
    );
  });

  it("matches a mid-pattern literal glob against absolutely-walked paths", () => {
    const result = expandComponentPaths(["packages/ui/*.tsx"], absoluteReader(FILES));
    expect(result.error).toBeUndefined();
    expect(result.paths).toHaveLength(2);
  });

  it("keeps matching a leading-wildcard glob against absolutely-walked paths", () => {
    const result = expandComponentPaths(["**/*.tsx"], absoluteReader(FILES));
    expect(result.error).toBeUndefined();
    expect(result.paths).toHaveLength(5);
  });

  it("matches a Windows-style backslash pattern against absolutely-walked paths", () => {
    const result = expandComponentPaths(["src\\**\\*.tsx"], absoluteReader(FILES));
    expect(result.error).toBeUndefined();
    expect(result.paths).toHaveLength(3);
  });
});

// A pattern typed as an absolute path (`C:/repo/src/**/*.tsx`,
// `/repo/src/**/*.tsx`) is already anchored to the same frame
// nodePathReader().walk returns, so relativizing the walked path to cwd (the
// M67 fix above) makes it never match. This reader returns exactly the
// absolute paths it is given, filtered on a posix-normalized prefix, so the
// test is independent of how the host platform's own path.resolve behaves.
function fixedFilesReader(files: string[]): PathReader {
  return {
    exists: () => false,
    isDirectory: () => false,
    walk: (root) => {
      const rootPosix = root.replace(/\\/g, "/");
      const prefix = rootPosix.endsWith("/") ? rootPosix : `${rootPosix}/`;
      return files.filter((f) => `${f.replace(/\\/g, "/")}/`.startsWith(prefix));
    },
  };
}

describe("path expansion for an absolute glob pattern", () => {
  it("matches a Windows-style absolute glob (drive letter, built via path.resolve)", () => {
    const files = [
      path.resolve("C:/win-fixture/src", "components/Button.tsx"),
      path.resolve("C:/win-fixture/src", "main.tsx"),
      path.resolve("C:/win-fixture/src", "components/Button.test.tsx"),
    ];
    const result = expandComponentPaths(
      ["C:/win-fixture/src/**/*.tsx"],
      fixedFilesReader(files),
    );
    expect(result.error).toBeUndefined();
    expect(result.paths.slice().sort()).toEqual(
      [
        path.resolve("C:/win-fixture/src", "components/Button.tsx"),
        path.resolve("C:/win-fixture/src", "main.tsx"),
      ].sort(),
    );
  });

  it("matches a POSIX-style absolute glob (built via path.posix.resolve)", () => {
    const files = [
      path.posix.resolve("/posix-fixture/src/components/Button.tsx"),
      path.posix.resolve("/posix-fixture/src/main.tsx"),
      path.posix.resolve("/posix-fixture/src/components/Button.test.tsx"),
    ];
    const result = expandComponentPaths(
      ["/posix-fixture/src/**/*.tsx"],
      fixedFilesReader(files),
    );
    expect(result.error).toBeUndefined();
    expect(result.paths.slice().sort()).toEqual(
      [
        path.posix.resolve("/posix-fixture/src/components/Button.tsx"),
        path.posix.resolve("/posix-fixture/src/main.tsx"),
      ].sort(),
    );
  });
});

import { resolveReportPaths } from "../../src/cli.js";

describe("--json survives expansion into many components", () => {
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

  it("disambiguates report names that collide only in case", () => {
    // 120fps-report.Card.json and 120fps-report.card.json are the same file
    // on NTFS/APFS; the second write must not silently clobber the first.
    const out = resolveReportPaths(["src/Card.tsx", "src/legacy/card.tsx"]);
    expect(new Set(out.map((p) => p.toLowerCase())).size).toBe(2);
  });

  it("keeps a directory prefix from the explicit path", () => {
    expect(resolveReportPaths(["a/x.tsx", "b/y.tsx"], "reports/run.json")[0])
      .toBe("reports/run.x.json");
  });
});
