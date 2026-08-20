import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectNextJs,
  detectTailwindVite,
  detectReactCompiler,
  detectProjectTransforms,
  HOISTED_TRANSFORM_WARNING,
} from "../../src/harness.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "120fps-monorepo-")));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// A workspace whose root manifest carries the tooling and whose member declares
// only what the given sections say.
function makeWorkspace(rootManifest: unknown, memberManifest: unknown = {}): string {
  fs.writeFileSync(path.join(tmpDir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify(rootManifest));
  const member = path.join(tmpDir, "packages", "ui");
  fs.mkdirSync(member, { recursive: true });
  fs.writeFileSync(path.join(member, "package.json"), JSON.stringify(memberManifest));
  return member;
}

function makeSinglePackage(manifest: unknown): string {
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify(manifest));
  return tmpDir;
}

function installPackage(root: string, name: string): void {
  const dir = path.join(root, "node_modules", ...name.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
}

const FIXTURE_MEMBER = path.resolve("fixtures/workspace-monorepo/packages/ui");

describe("Next.js detection across workspace levels", () => {
  it("sees next declared by the workspace root", () => {
    const member = makeWorkspace({ dependencies: { next: "^15.0.0" } });
    expect(detectNextJs(member)).toBe(true);
  });

  it("sees next in peerDependencies, like every other detector", () => {
    expect(detectNextJs(makeSinglePackage({ peerDependencies: { next: "^15.0.0" } }))).toBe(true);
  });

  it("stays false when no level declares or installs next", () => {
    expect(detectNextJs(makeWorkspace({ dependencies: { react: "^19.0.0" } }))).toBe(false);
  });

  it("stays false for a directory with no manifest at all", () => {
    expect(detectNextJs(path.join(tmpDir, "nowhere"))).toBe(false);
  });

  it("sees next in the workspace fixture from a member that declares nothing", () => {
    expect(detectNextJs(FIXTURE_MEMBER)).toBe(true);
  });
});

describe("Tailwind plugin detection across workspace levels", () => {
  it("sees @tailwindcss/vite declared by the workspace root", () => {
    const member = makeWorkspace({ devDependencies: { "@tailwindcss/vite": "^4.3.3" } });
    expect(detectTailwindVite(member)).toBe(true);
  });

  it("sees @tailwindcss/vite installed at the workspace root", () => {
    const member = makeWorkspace({});
    installPackage(tmpDir, "@tailwindcss/vite");
    expect(detectTailwindVite(member)).toBe(true);
  });

  it("keeps answering from the member's own manifest in a single-package repo", () => {
    expect(
      detectTailwindVite(makeSinglePackage({ devDependencies: { "@tailwindcss/vite": "^4.3.3" } })),
    ).toBe(true);
  });

  it("does not mistake the PostCSS-only setup for the Vite plugin", () => {
    expect(detectTailwindVite(makeSinglePackage({ devDependencies: { tailwindcss: "^4.3.3" } }))).toBe(
      false,
    );
  });

  it("sees the plugin in the workspace fixture from a member that declares nothing", () => {
    expect(detectTailwindVite(FIXTURE_MEMBER)).toBe(true);
  });
});

describe("React Compiler detection across workspace levels", () => {
  it("sees the plugin declared by the workspace root", () => {
    const member = makeWorkspace({ devDependencies: { "babel-plugin-react-compiler": "^1.0.0" } });
    expect(detectReactCompiler(member)).toBe(true);
  });

  // The compiler rewrites the measured code, so a hoisted transitive copy is
  // not enough: some manifest has to say the project ships it (M27 H14).
  it("ignores a plugin that is installed but declared nowhere", () => {
    const member = makeWorkspace({});
    installPackage(tmpDir, "babel-plugin-react-compiler");
    expect(detectReactCompiler(member)).toBe(false);
  });

  it("stays false when no level has it", () => {
    expect(detectReactCompiler(makeWorkspace({ dependencies: { react: "^19.0.0" } }))).toBe(false);
  });

  it("sees the plugin in the workspace fixture from a member that declares nothing", () => {
    expect(detectReactCompiler(FIXTURE_MEMBER)).toBe(true);
  });
});

describe("project transform detection across workspace levels", () => {
  it("loads the Vue transform for a member whose workspace root declares the plugin", () => {
    const member = makeWorkspace({ devDependencies: { "@vitejs/plugin-vue": "^5.2.0" } });
    expect(detectProjectTransforms(member).map((t) => t.code)).toContain("vue");
  });

  it("loads a transform whose package is only installed, never declared", () => {
    const member = makeWorkspace({});
    installPackage(member, "vite-plugin-svgr");
    expect(detectProjectTransforms(member).map((t) => t.code)).toContain("svgr");
  });

  it("returns nothing for a workspace that has none of them", () => {
    expect(detectProjectTransforms(makeWorkspace({ dependencies: { react: "^19.0.0" } }))).toEqual(
      [],
    );
  });

  it("returns nothing for a directory with no manifest", () => {
    expect(detectProjectTransforms(path.join(tmpDir, "nowhere"))).toEqual([]);
  });

  it("loads the Vue transform in the workspace fixture from a member that declares nothing", () => {
    expect(detectProjectTransforms(FIXTURE_MEMBER).map((t) => t.code)).toContain("vue");
  });

  it("keeps a project without the Vue plugin free of the Vue transform", () => {
    expect(
      detectProjectTransforms(path.resolve("fixtures/vue-noplugin")).map((t) => t.code),
    ).not.toContain("vue");
  });
});

// M83 #8 (primevue-Probe1): resolution via the hoisted-transitive-copy
// fallback is correct and by design (M75) — only the disclosure was
// missing. A plugin resolved that way, not declared in this project's own
// package.json (at either workspace level), now names itself.
describe("HOISTED_TRANSFORM_WARNING disclosure", () => {
  it("warns for a plugin resolved only via the hoisted fallback, not declared anywhere", () => {
    const member = makeWorkspace({});
    installPackage(member, "vite-plugin-svgr");
    const warnings: string[] = [];
    detectProjectTransforms(member, undefined, (w) => warnings.push(w));
    expect(warnings).toEqual([HOISTED_TRANSFORM_WARNING("vite-plugin-svgr")]);
  });

  it("says nothing when the plugin is declared at the workspace root", () => {
    const member = makeWorkspace({ devDependencies: { "@vitejs/plugin-vue": "^5.2.0" } });
    const warnings: string[] = [];
    detectProjectTransforms(member, undefined, (w) => warnings.push(w));
    expect(warnings).toEqual([]);
  });

  it("says nothing when the plugin is declared by the member itself", () => {
    const member = makeSinglePackage({ devDependencies: { "@vitejs/plugin-vue": "^5.2.0" } });
    const warnings: string[] = [];
    detectProjectTransforms(member, undefined, (w) => warnings.push(w));
    expect(warnings).toEqual([]);
  });

  it("says nothing when onWarning is not supplied (backward compatible)", () => {
    const member = makeWorkspace({});
    installPackage(member, "vite-plugin-svgr");
    expect(() => detectProjectTransforms(member)).not.toThrow();
  });
});
