import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectFramework, FRAMEWORK_MANIFEST_UNREADABLE } from "../../src/react-profiler.js";
import { resolveFramework, FRAMEWORK_FLAG_NO_MOUNT_EFFECT_WARNING } from "../../src/analyze.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "120fps-framework-precedence-")));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeWorkspace(rootManifest: unknown, memberManifest: unknown = {}): string {
  fs.writeFileSync(path.join(tmpDir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify(rootManifest));
  const member = path.join(tmpDir, "packages", "ui");
  fs.mkdirSync(member, { recursive: true });
  fs.writeFileSync(path.join(member, "package.json"), JSON.stringify(memberManifest));
  return member;
}

function installPackage(root: string, name: string): void {
  const dir = path.join(root, "node_modules", ...name.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
}

function makeManifest(content: string): string {
  const dir = fs.mkdtempSync(path.join(tmpDir, "member-"));
  fs.writeFileSync(path.join(dir, "package.json"), content);
  return dir;
}

describe("framework detection precedence", () => {
  it("lets a Vue member outrank a React workspace root", () => {
    const member = makeWorkspace(
      { dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" } },
      { dependencies: { vue: "^3.5.0" } },
    );
    expect(detectFramework(member)).toBe("vue");
  });

  it("lets a React member outrank a Vue workspace root", () => {
    const member = makeWorkspace(
      { dependencies: { vue: "^3.5.0" } },
      { dependencies: { react: "^19.0.0" } },
    );
    expect(detectFramework(member)).toBe("react");
  });

  it("falls back to a React workspace root for a member that names no framework", () => {
    expect(detectFramework(makeWorkspace({ dependencies: { react: "^19.0.0" } }))).toBe("react");
  });

  it("falls back to a Vue workspace root for a member that names no framework", () => {
    expect(detectFramework(makeWorkspace({ dependencies: { vue: "^3.5.0" } }))).toBe("vue");
  });

  it("falls back to what is installed when no manifest names a framework", () => {
    const member = makeWorkspace({});
    installPackage(tmpDir, "vue");
    expect(detectFramework(member)).toBe("vue");
  });

  it("stays vanilla when no level declares or installs a framework", () => {
    expect(detectFramework(makeWorkspace({ dependencies: { lodash: "^4.0.0" } }))).toBe("vanilla");
  });

  it("reads the workspace fixture per member", () => {
    expect(detectFramework(path.resolve("fixtures/workspace-monorepo/packages/ui"))).toBe("react");
    expect(detectFramework(path.resolve("fixtures/workspace-monorepo/packages/vue-widget"))).toBe(
      "vue",
    );
  });
});

// Mounting non-React code as React is the failure the old `react` default
// produced; an unreadable manifest is evidence of nothing.
describe("framework detection on an unreadable manifest", () => {
  it("returns vanilla and warns when the manifest is missing", () => {
    const dir = path.join(tmpDir, "empty");
    fs.mkdirSync(dir);
    const warnings: string[] = [];
    expect(detectFramework(dir, (w) => warnings.push(w))).toBe("vanilla");
    expect(warnings).toEqual([FRAMEWORK_MANIFEST_UNREADABLE(dir)]);
  });

  it("returns vanilla and warns when the manifest is malformed JSON", () => {
    const dir = makeManifest("{ not valid json !!");
    const warnings: string[] = [];
    expect(detectFramework(dir, (w) => warnings.push(w))).toBe("vanilla");
    expect(warnings).toHaveLength(1);
  });

  it("returns vanilla and warns when the manifest is valid JSON but not an object", () => {
    const warnings: string[] = [];
    expect(detectFramework(makeManifest('"just a string"'), (w) => warnings.push(w))).toBe("vanilla");
    expect(detectFramework(makeManifest("null"))).toBe("vanilla");
    expect(warnings).toHaveLength(1);
  });

  it("returns vanilla when a dependency section is not an object", () => {
    expect(detectFramework(makeManifest(JSON.stringify({ dependencies: "react" })))).toBe("vanilla");
  });

  it("warns at most once per call", () => {
    const warnings: string[] = [];
    detectFramework(makeManifest("{ broken"), (w) => warnings.push(w));
    expect(warnings).toHaveLength(1);
  });

  it("says nothing when the manifest reads fine", () => {
    const warnings: string[] = [];
    detectFramework(makeManifest(JSON.stringify({ dependencies: { react: "^19.0.0" } })), (w) =>
      warnings.push(w),
    );
    expect(warnings).toEqual([]);
  });
});

describe("framework resolution around the detector", () => {
  it("forwards the detector's warning to the caller", () => {
    const dir = path.join(tmpDir, "empty");
    fs.mkdirSync(dir);
    const warnings: string[] = [];
    expect(resolveFramework("auto", dir, undefined, (w) => warnings.push(w))).toBe("vanilla");
    expect(warnings).toEqual([FRAMEWORK_MANIFEST_UNREADABLE(dir)]);
  });

  it("keeps the measured file's own type above every other signal", () => {
    const member = makeWorkspace({ dependencies: { react: "^19.0.0" } });
    const warnings: string[] = [];
    expect(
      resolveFramework("auto", member, path.join(member, "Widget.vue"), (w) => warnings.push(w)),
    ).toBe("vue");
    expect(warnings).toEqual([]);
  });

  it("says nothing when the framework was given explicitly", () => {
    const dir = path.join(tmpDir, "empty");
    fs.mkdirSync(dir);
    const warnings: string[] = [];
    expect(resolveFramework("react", dir, undefined, (w) => warnings.push(w))).toBe("react");
    expect(warnings).toEqual([]);
  });
});

// M83 #4b (preact-app-F4): mount dispatch is purely extension-based; an
// explicit --framework request that disagrees with what will actually mount
// used to be silently discarded in both directions.
describe("M83 #4b: --framework flag versus what actually mounts", () => {
  it("warns when --framework vanilla is requested on a .tsx file (mounts react anyway)", () => {
    const dir = path.join(tmpDir, "empty");
    fs.mkdirSync(dir);
    const warnings: string[] = [];
    const result = resolveFramework("vanilla", dir, "Button.tsx", (w) => warnings.push(w));
    expect(result).toBe("vanilla");
    expect(warnings).toEqual([FRAMEWORK_FLAG_NO_MOUNT_EFFECT_WARNING("vanilla", "react")]);
  });

  it("says nothing when --framework react matches what a .tsx file actually mounts", () => {
    const dir = path.join(tmpDir, "empty");
    fs.mkdirSync(dir);
    const warnings: string[] = [];
    const result = resolveFramework("react", dir, "Button.tsx", (w) => warnings.push(w));
    expect(result).toBe("react");
    expect(warnings).toEqual([]);
  });

  it("warns when --framework react is requested on a .vue file (mounts vue anyway, and framework is force-reset)", () => {
    const dir = path.join(tmpDir, "empty");
    fs.mkdirSync(dir);
    const warnings: string[] = [];
    const result = resolveFramework("react", dir, "Widget.vue", (w) => warnings.push(w));
    expect(result).toBe("vue");
    expect(warnings).toEqual([FRAMEWORK_FLAG_NO_MOUNT_EFFECT_WARNING("react", "vue")]);
  });

  it("warns when --framework vue is requested on a non-.vue file", () => {
    const dir = path.join(tmpDir, "empty");
    fs.mkdirSync(dir);
    const warnings: string[] = [];
    const result = resolveFramework("vue", dir, "Button.tsx", (w) => warnings.push(w));
    expect(result).toBe("vue");
    expect(warnings).toEqual([FRAMEWORK_FLAG_NO_MOUNT_EFFECT_WARNING("vue", "react")]);
  });

  it("auto is exempt in both directions", () => {
    const member = makeWorkspace({ dependencies: { react: "^19.0.0" } });
    const warnings: string[] = [];
    resolveFramework("auto", member, path.join(member, "Widget.vue"), (w) => warnings.push(w));
    expect(warnings).toEqual([]);
  });
});
