import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { findProjectRoot } from "../../src/harness.js";
import { resolveProjectPaths, legacyBaselineWarning, resolveFramework } from "../../src/analyze.js";
import { saveBaseline, loadBaseline, loadBudgetConfig,
  selectBaselineEntry,
} from "../../src/budget.js";

// M45: entries are keyed by component x environment slot; selectBaselineEntry
// resolves the slot for us so these assertions stay about the entry, not the key.
function entryOf(baseline: any, componentPath: string) {
  return selectBaselineEntry(baseline, componentPath, "unused")!.entry;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-m24-root-"));
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

describe("D7: findProjectRoot (exported)", () => {
  it("finds nearest ancestor with package.json", () => {
    makeTree({ "package.json": "{}", "src/ui/Button.tsx": "export const Button = () => null;" });
    expect(findProjectRoot(path.join(tmpDir, "src", "ui"))).toBe(tmpDir);
  });

  it("nearest package.json wins in a monorepo (workspace package, not repo root)", () => {
    makeTree({
      "package.json": "{}",
      "packages/a/package.json": "{}",
      "packages/a/src/Button.tsx": "x",
    });
    expect(findProjectRoot(path.join(tmpDir, "packages", "a", "src"))).toBe(
      path.join(tmpDir, "packages", "a"),
    );
  });

  it("returns undefined when no ancestor has package.json (mocked fs)", () => {
    const spy = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    try {
      expect(findProjectRoot(path.join(tmpDir, "src", "ui"))).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("resolveProjectPaths falls back to the component dir when no package.json exists (mocked fs)", () => {
    const componentAbs = path.join(tmpDir, "src", "ui", "Button.tsx");
    const spy = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    try {
      const { projectRoot, relativeComponent } = resolveProjectPaths(componentAbs);
      expect(projectRoot).toBe(path.join(tmpDir, "src", "ui"));
      expect(relativeComponent).toBe("./Button.tsx");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("D7: resolveProjectPaths", () => {
  it("resolves package root and posix-normalized key for nested component", () => {
    makeTree({ "package.json": "{}", "src/ui/Button.tsx": "x" });
    const { projectRoot, relativeComponent } = resolveProjectPaths(
      path.join(tmpDir, "src", "ui", "Button.tsx"),
    );
    expect(projectRoot).toBe(tmpDir);
    expect(relativeComponent).toBe("./src/ui/Button.tsx");
  });

  it("component at repo root: projectRoot == dirname, key is ./Button.tsx", () => {
    makeTree({ "package.json": "{}", "Button.tsx": "x" });
    const { projectRoot, relativeComponent } = resolveProjectPaths(path.join(tmpDir, "Button.tsx"));
    expect(projectRoot).toBe(tmpDir);
    expect(relativeComponent).toBe("./Button.tsx");
  });

  it("monorepo: root is the workspace package containing the component", () => {
    makeTree({
      "package.json": "{}",
      "packages/a/package.json": "{}",
      "packages/a/src/Button.tsx": "x",
    });
    const { projectRoot, relativeComponent } = resolveProjectPaths(
      path.join(tmpDir, "packages", "a", "src", "Button.tsx"),
    );
    expect(projectRoot).toBe(path.join(tmpDir, "packages", "a"));
    expect(relativeComponent).toBe("./src/Button.tsx");
  });
});

describe("D7: baseline and config land at the package root", () => {
  it("saveBaseline via resolved root writes repoRoot/120fps-baseline.json with posix key", () => {
    makeTree({ "package.json": "{}", "src/ui/Button.tsx": "x" });
    const componentAbs = path.join(tmpDir, "src", "ui", "Button.tsx");
    const { projectRoot, relativeComponent } = resolveProjectPaths(componentAbs);
    const baselinePath = path.join(projectRoot, "120fps-baseline.json");
    saveBaseline(
      baselinePath,
      { mount: 1, rerender: 0.5, unmount: 0.1, domNodeCount: 3, interactions: {}, tier: "T1" },
      relativeComponent,
    );
    expect(fs.existsSync(path.join(tmpDir, "120fps-baseline.json"))).toBe(true);
    const loaded = loadBaseline(baselinePath);
    expect(entryOf(loaded, "./src/ui/Button.tsx").mount).toBe(1);
  });

  it("120fps.config.json at package root is found via resolved root", () => {
    makeTree({
      "package.json": "{}",
      "120fps.config.json": JSON.stringify({ tolerance: { mount: 25 } }),
      "src/ui/Button.tsx": "x",
    });
    const { projectRoot } = resolveProjectPaths(path.join(tmpDir, "src", "ui", "Button.tsx"));
    const config = loadBudgetConfig(projectRoot);
    expect(config).not.toBeNull();
    expect(config!.tolerance!.mount).toBe(25);
  });
});

describe("D7: legacy baseline migration guard", () => {
  it("returns a warning when a legacy baseline sits next to the component", () => {
    makeTree({
      "package.json": "{}",
      "src/ui/Button.tsx": "x",
      "src/ui/120fps-baseline.json": JSON.stringify({ version: 1, timestamp: "x", entries: {} }),
    });
    const componentDir = path.join(tmpDir, "src", "ui");
    const warning = legacyBaselineWarning(tmpDir, componentDir);
    expect(warning).toBeDefined();
    expect(warning).toContain("--save-baseline");
    expect(warning).toContain(componentDir);
  });

  it("returns undefined when component dir equals the package root", () => {
    makeTree({
      "package.json": "{}",
      "Button.tsx": "x",
      "120fps-baseline.json": JSON.stringify({ version: 1, timestamp: "x", entries: {} }),
    });
    expect(legacyBaselineWarning(tmpDir, tmpDir)).toBeUndefined();
  });

  it("returns undefined when no legacy baseline exists next to the component", () => {
    makeTree({ "package.json": "{}", "src/ui/Button.tsx": "x" });
    expect(legacyBaselineWarning(tmpDir, path.join(tmpDir, "src", "ui"))).toBeUndefined();
  });
});

describe("D4 call-site: resolveFramework precedence", () => {
  it("explicit react skips detection (no react in package.json)", () => {
    makeTree({ "package.json": JSON.stringify({ dependencies: { lodash: "^4.0.0" } }) });
    expect(resolveFramework("react", tmpDir)).toBe("react");
  });

  it("explicit vanilla skips detection (react present in package.json)", () => {
    makeTree({ "package.json": JSON.stringify({ dependencies: { react: "^18.0.0" } }) });
    expect(resolveFramework("vanilla", tmpDir)).toBe("vanilla");
  });

  it("auto detects react from package.json", () => {
    makeTree({ "package.json": JSON.stringify({ devDependencies: { "react-dom": "^18.0.0" } }) });
    expect(resolveFramework("auto", tmpDir)).toBe("react");
  });

  it("auto detects vanilla when no react dependency", () => {
    makeTree({ "package.json": JSON.stringify({ dependencies: { vue: "^3.0.0" } }) });
    expect(resolveFramework("auto", tmpDir)).toBe("vanilla");
  });
});
