import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runPreflight,
  classifyPreprocessorAvailability,
  PROJECT_TRANSFORM_WARNING,
  recognizeTransform,
  CSS_PREPROCESSOR_PACKAGES,
} from "../../src/preflight.js";
import { findWorkspaceRoot } from "../../src/project-model.js";

// M79 (3c, twenty-F3's false positive; excalidraw-F3). The css-preprocessor
// recognizer (preflight.ts) performs no availability check by design and
// fires unconditionally for every .scss/.sass/.less/.styl import — that part
// is unchanged and test-locked (project-transforms.test.ts:98-99). The fix
// is entirely downstream: a three-way classification (installed /
// declared-but-not-installed / neither) that decides whether the warning
// fires at all, and how it is worded.

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-m79-preproc-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const file = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function installPackage(pkg: string): void {
  const pkgDir = path.join(tmpDir, "node_modules", pkg);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: pkg, version: "1.0.0" }));
}

function scssHit() {
  write("Button.tsx", 'import "./theme.scss";\nexport default function Button() { return null; }\n');
  const result = runPreflight({ projectRoot: tmpDir, entries: [path.join(tmpDir, "Button.tsx")] });
  const hit = result.transforms.find((t) => t.transformCode === "css-preprocessor");
  if (!hit) throw new Error("expected a css-preprocessor hit");
  return hit;
}

describe("recognizeTransform: unchanged, no availability check (existing contract)", () => {
  it("still classifies .scss as css-preprocessor regardless of what is installed", () => {
    expect(recognizeTransform("./theme.scss")?.code).toBe("css-preprocessor");
  });
});

describe("CSS_PREPROCESSOR_PACKAGES: extension coverage", () => {
  it("maps every recognized extension to at least one package", () => {
    for (const ext of [".scss", ".sass", ".less", ".styl", ".stylus"]) {
      expect(CSS_PREPROCESSOR_PACKAGES[ext]?.length).toBeGreaterThan(0);
    }
  });
});

describe("classifyPreprocessorAvailability", () => {
  it("returns undefined for a non-css-preprocessor hit", () => {
    write("Icon.tsx", 'import Logo from "./logo.svg?react";\nexport default Logo;\n');
    const result = runPreflight({ projectRoot: tmpDir, entries: [path.join(tmpDir, "Icon.tsx")] });
    const hit = result.transforms.find((t) => t.transformCode === "svgr")!;
    const workspaceRoot = findWorkspaceRoot(tmpDir);
    expect(classifyPreprocessorAvailability(hit, tmpDir, workspaceRoot)).toBeUndefined();
  });

  it("returns 'neither' when the preprocessor is neither declared nor installed", () => {
    write("package.json", JSON.stringify({ dependencies: {} }));
    const hit = scssHit();
    const workspaceRoot = findWorkspaceRoot(tmpDir);
    expect(classifyPreprocessorAvailability(hit, tmpDir, workspaceRoot)).toBe("neither");
  });

  it("returns 'declared-not-installed' when package.json lists it but node_modules does not have it", () => {
    write("package.json", JSON.stringify({ dependencies: { sass: "^1.70.0" } }));
    const hit = scssHit();
    const workspaceRoot = findWorkspaceRoot(tmpDir);
    expect(classifyPreprocessorAvailability(hit, tmpDir, workspaceRoot)).toBe("declared-not-installed");
  });

  it("returns 'installed' when the package actually resolves on disk (twenty-F3: sass-embedded)", () => {
    write("package.json", JSON.stringify({ dependencies: {} }));
    installPackage("sass-embedded");
    const hit = scssHit();
    const workspaceRoot = findWorkspaceRoot(tmpDir);
    expect(classifyPreprocessorAvailability(hit, tmpDir, workspaceRoot)).toBe("installed");
  });

  it("returns 'installed' even when undeclared but physically present (bare-clone shape)", () => {
    write("package.json", JSON.stringify({ dependencies: {} }));
    installPackage("sass");
    const hit = scssHit();
    const workspaceRoot = findWorkspaceRoot(tmpDir);
    expect(classifyPreprocessorAvailability(hit, tmpDir, workspaceRoot)).toBe("installed");
  });

  it("'installed' wins over 'declared' when both are true", () => {
    write("package.json", JSON.stringify({ dependencies: { sass: "^1.70.0" } }));
    installPackage("sass");
    const hit = scssHit();
    const workspaceRoot = findWorkspaceRoot(tmpDir);
    expect(classifyPreprocessorAvailability(hit, tmpDir, workspaceRoot)).toBe("installed");
  });

  it("classifies .less against the less package", () => {
    write("package.json", JSON.stringify({ dependencies: { less: "^4.0.0" } }));
    write("Button.tsx", 'import "./theme.less";\nexport default function Button() { return null; }\n');
    const result = runPreflight({ projectRoot: tmpDir, entries: [path.join(tmpDir, "Button.tsx")] });
    const hit = result.transforms.find((t) => t.transformCode === "css-preprocessor")!;
    const workspaceRoot = findWorkspaceRoot(tmpDir);
    expect(classifyPreprocessorAvailability(hit, tmpDir, workspaceRoot)).toBe("declared-not-installed");
  });
});

describe("PROJECT_TRANSFORM_WARNING wording per availability", () => {
  it("keeps the original 'needs ... installed' wording for the neither case (undefined availability)", () => {
    const hit = { kind: "project-transform" as const, chain: ["Button.tsx"], specifier: "./theme.scss", transformCode: "css-preprocessor", transformOwner: "a CSS preprocessor (Vite needs sass/less/stylus installed in the project)" };
    expect(PROJECT_TRANSFORM_WARNING(hit)).toContain("sass/less/stylus");
    expect(PROJECT_TRANSFORM_WARNING(hit, "neither")).toContain("sass/less/stylus");
  });

  it("switches to 'declared ... not installed' wording", () => {
    const hit = { kind: "project-transform" as const, chain: ["Button.tsx"], specifier: "./theme.scss", transformCode: "css-preprocessor", transformOwner: "a CSS preprocessor (Vite needs sass/less/stylus installed in the project)" };
    const text = PROJECT_TRANSFORM_WARNING(hit, "declared-not-installed");
    expect(text).toContain("declared in package.json but not installed");
    expect(text).not.toContain("needs a CSS preprocessor (Vite needs");
  });

  it("does not change wording for a non-css-preprocessor hit even if an availability value were passed", () => {
    const hit = { kind: "project-transform" as const, chain: ["Icon.tsx"], specifier: "./logo.svg?react", transformCode: "svgr", transformOwner: "vite-plugin-svgr" };
    const text = PROJECT_TRANSFORM_WARNING(hit, "declared-not-installed");
    expect(text).toContain("vite-plugin-svgr");
    expect(text).not.toContain("declared in package.json but not installed");
  });
});

describe("end-to-end filtering shape (mirrors analyze.ts's transformHits computation)", () => {
  function filterAndWord(hit: ReturnType<typeof scssHit>, workspaceRoot: string) {
    const availability = classifyPreprocessorAvailability(hit, tmpDir, workspaceRoot);
    if (availability === "installed") return undefined;
    return PROJECT_TRANSFORM_WARNING(hit, availability);
  }

  it("produces no warning at all when the preprocessor is installed (twenty-F3)", () => {
    write("package.json", JSON.stringify({ dependencies: {} }));
    installPackage("sass-embedded");
    const hit = scssHit();
    const workspaceRoot = findWorkspaceRoot(tmpDir);
    expect(filterAndWord(hit, workspaceRoot)).toBeUndefined();
  });

  it("produces the declared-not-installed warning (excalidraw-F3's own gap)", () => {
    write("package.json", JSON.stringify({ dependencies: { sass: "^1.70.0" } }));
    const hit = scssHit();
    const workspaceRoot = findWorkspaceRoot(tmpDir);
    const warning = filterAndWord(hit, workspaceRoot);
    expect(warning).toBeDefined();
    expect(warning).toContain("declared in package.json but not installed");
  });

  it("produces the original warning when genuinely neither declared nor installed", () => {
    write("package.json", JSON.stringify({ dependencies: {} }));
    const hit = scssHit();
    const workspaceRoot = findWorkspaceRoot(tmpDir);
    const warning = filterAndWord(hit, workspaceRoot);
    expect(warning).toBeDefined();
    expect(warning).toContain("sass/less/stylus");
  });
});
