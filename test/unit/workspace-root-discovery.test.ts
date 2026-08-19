import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findProjectRoot,
  findWorkspaceRoot,
  resolveProjectModel,
  declaredPackages,
  isPackageAvailable,
  detectPnP,
} from "../../src/project-model.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "120fps-workspace-")));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTree(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function installPackage(root: string, name: string): void {
  const dir = path.join(root, "node_modules", ...name.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
}

const member = (): string => path.join(tmpDir, "packages", "ui");

describe("workspace root discovery", () => {
  it("is the member itself when no ancestor governs an install", () => {
    makeTree({ "packages/ui/package.json": "{}" });
    expect(findWorkspaceRoot(member())).toBe(member());
  });

  it("finds an ancestor carrying pnpm-workspace.yaml", () => {
    makeTree({
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "package.json": "{}",
      "packages/ui/package.json": "{}",
    });
    expect(findWorkspaceRoot(member())).toBe(tmpDir);
  });

  it("finds an ancestor whose manifest declares workspaces as an array", () => {
    makeTree({
      "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "packages/ui/package.json": "{}",
    });
    expect(findWorkspaceRoot(member())).toBe(tmpDir);
  });

  it("finds an ancestor whose manifest declares workspaces as an object", () => {
    makeTree({
      "package.json": JSON.stringify({ workspaces: { packages: ["packages/*"] } }),
      "packages/ui/package.json": "{}",
    });
    expect(findWorkspaceRoot(member())).toBe(tmpDir);
  });

  it.each(["pnpm-lock.yaml", "yarn.lock", "package-lock.json"])(
    "finds an ancestor carrying %s",
    (lockfile) => {
      makeTree({
        [lockfile]: "",
        "package.json": "{}",
        "packages/ui/package.json": "{}",
      });
      expect(findWorkspaceRoot(member())).toBe(tmpDir);
    },
  );

  it("is the member itself when the member carries the lockfile", () => {
    makeTree({ "packages/ui/package.json": "{}", "packages/ui/pnpm-lock.yaml": "" });
    expect(findWorkspaceRoot(member())).toBe(member());
  });

  it("takes the nearest governing ancestor, not the outermost", () => {
    makeTree({
      "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n',
      "package.json": "{}",
      "apps/inner/pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "apps/inner/package.json": "{}",
      "apps/inner/packages/ui/package.json": "{}",
    });
    expect(findWorkspaceRoot(path.join(tmpDir, "apps", "inner", "packages", "ui"))).toBe(
      path.join(tmpDir, "apps", "inner"),
    );
  });

  it("stops at the repository the member belongs to", () => {
    makeTree({
      "pnpm-lock.yaml": "",
      "repo/package.json": "{}",
      "repo/packages/ui/package.json": "{}",
    });
    fs.mkdirSync(path.join(tmpDir, "repo", ".git"), { recursive: true });
    const inner = path.join(tmpDir, "repo", "packages", "ui");
    expect(findWorkspaceRoot(inner)).toBe(inner);
  });

  it("still reads the repository root's own markers before stopping", () => {
    makeTree({
      "repo/pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "repo/package.json": "{}",
      "repo/packages/ui/package.json": "{}",
    });
    fs.mkdirSync(path.join(tmpDir, "repo", ".git"), { recursive: true });
    expect(findWorkspaceRoot(path.join(tmpDir, "repo", "packages", "ui"))).toBe(
      path.join(tmpDir, "repo"),
    );
  });

  it("resolves both roots for a component directory", () => {
    makeTree({
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "package.json": "{}",
      "packages/ui/package.json": "{}",
      "packages/ui/src/Button.tsx": "x",
    });
    const model = resolveProjectModel(path.join(tmpDir, "packages", "ui", "src"));
    expect(model.memberRoot).toBe(member());
    expect(model.workspaceRoot).toBe(tmpDir);
  });

  it("keeps both roots equal in a single-package repository", () => {
    makeTree({ "package.json": "{}", "pnpm-lock.yaml": "", "src/Button.tsx": "x" });
    const model = resolveProjectModel(path.join(tmpDir, "src"));
    expect(model.memberRoot).toBe(tmpDir);
    expect(model.workspaceRoot).toBe(tmpDir);
  });

  it("falls back to the given directory when no ancestor has a manifest", () => {
    makeTree({ "src/Button.tsx": "x" });
    const dir = path.join(tmpDir, "src");
    const model = resolveProjectModel(dir);
    expect(model.memberRoot).toBe(dir);
    expect(findProjectRoot(dir)).toBeUndefined();
  });

  it("reads the workspace fixture's two levels", () => {
    const root = path.resolve("fixtures/workspace-monorepo");
    const ui = path.join(root, "packages", "ui");
    expect(findProjectRoot(ui)).toBe(ui);
    expect(findWorkspaceRoot(ui)).toBe(root);
  });
});

describe("declared package names", () => {
  it("unions the three dependency sections", () => {
    makeTree({
      "package.json": JSON.stringify({
        dependencies: { react: "^19.0.0" },
        devDependencies: { vitest: "^3.0.0" },
        peerDependencies: { next: "^15.0.0" },
      }),
    });
    expect([...declaredPackages(tmpDir)].sort()).toEqual(["next", "react", "vitest"]);
  });

  it("is empty for a missing, unparsable, or non-object manifest", () => {
    expect(declaredPackages(path.join(tmpDir, "nowhere")).size).toBe(0);
    makeTree({ "broken/package.json": "{ not json", "scalar/package.json": '"a string"' });
    expect(declaredPackages(path.join(tmpDir, "broken")).size).toBe(0);
    expect(declaredPackages(path.join(tmpDir, "scalar")).size).toBe(0);
  });

  it("ignores a dependency section that is not an object", () => {
    makeTree({ "package.json": JSON.stringify({ dependencies: "react" }) });
    expect(declaredPackages(tmpDir).size).toBe(0);
  });
});

describe("package availability across workspace levels", () => {
  it("accepts a package the member declares", () => {
    makeTree({ "packages/ui/package.json": JSON.stringify({ dependencies: { vue: "^3.5.0" } }) });
    expect(isPackageAvailable("vue", member(), tmpDir)).toBe(true);
  });

  it("accepts a package only the workspace root declares", () => {
    makeTree({
      "package.json": JSON.stringify({ devDependencies: { "@vitejs/plugin-vue": "^5.2.0" } }),
      "packages/ui/package.json": "{}",
    });
    expect(isPackageAvailable("@vitejs/plugin-vue", member(), tmpDir)).toBe(true);
  });

  it("accepts a package installed at a level no manifest mentions", () => {
    makeTree({ "package.json": "{}", "packages/ui/package.json": "{}" });
    installPackage(tmpDir, "vite-plugin-svgr");
    expect(isPackageAvailable("vite-plugin-svgr", member(), tmpDir)).toBe(true);
  });

  it("accepts a scoped package installed at the member level", () => {
    makeTree({ "package.json": "{}", "packages/ui/package.json": "{}" });
    installPackage(member(), "@vanilla-extract/vite-plugin");
    expect(isPackageAvailable("@vanilla-extract/vite-plugin", member(), tmpDir)).toBe(true);
  });

  it("accepts a package installed between the member and the workspace root", () => {
    makeTree({ "package.json": "{}", "packages/ui/package.json": "{}" });
    installPackage(path.join(tmpDir, "packages"), "@tailwindcss/vite");
    expect(isPackageAvailable("@tailwindcss/vite", member(), tmpDir)).toBe(true);
  });

  // M75: the probe follows node's own lookup chain past the workspace root.
  // Every loader in this codebase resolves through createRequire, which has no
  // such bound, so stopping here reported packages the harness can import as
  // absent. test/unit/package-availability-resolution.test.ts owns the rule.
  it("accepts a package installed above the workspace root", () => {
    makeTree({ "repo/package.json": "{}", "repo/packages/ui/package.json": "{}" });
    installPackage(tmpDir, "next");
    const ui = path.join(tmpDir, "repo", "packages", "ui");
    expect(isPackageAvailable("next", ui, path.join(tmpDir, "repo"))).toBe(true);
  });

  it("refuses a package that is neither declared nor installed", () => {
    makeTree({ "package.json": "{}", "packages/ui/package.json": "{}" });
    expect(isPackageAvailable("next", member(), tmpDir)).toBe(false);
  });

  it("discovers the workspace root itself when none is given", () => {
    makeTree({
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "package.json": JSON.stringify({ dependencies: { next: "^15.0.0" } }),
      "packages/ui/package.json": "{}",
    });
    expect(isPackageAvailable("next", member())).toBe(true);
  });

  it("looks no further than the member in a single-package repository", () => {
    makeTree({ "package.json": JSON.stringify({ dependencies: { react: "^19.0.0" } }) });
    expect(isPackageAvailable("react", tmpDir, tmpDir)).toBe(true);
    expect(isPackageAvailable("next", tmpDir, tmpDir)).toBe(false);
  });
});

// M72: Yarn PnP replaces node_modules with a virtual filesystem this harness
// cannot resolve through, so it is detected and rejected rather than left to
// fail with a raw resolution error.
describe("Yarn PnP detection", () => {
  it("is false for a plain node_modules workspace", () => {
    makeTree({ "package.json": "{}" });
    expect(detectPnP(tmpDir)).toBe(false);
  });

  it("detects .pnp.cjs at the workspace root", () => {
    makeTree({ "package.json": "{}", ".pnp.cjs": "" });
    expect(detectPnP(tmpDir)).toBe(true);
  });

  it("detects .pnp.loader.mjs at the workspace root", () => {
    makeTree({ "package.json": "{}", ".pnp.loader.mjs": "" });
    expect(detectPnP(tmpDir)).toBe(true);
  });

  it("does not detect a PnP marker one level below the workspace root", () => {
    makeTree({ "package.json": "{}", "packages/ui/.pnp.cjs": "" });
    expect(detectPnP(tmpDir)).toBe(false);
  });
});
