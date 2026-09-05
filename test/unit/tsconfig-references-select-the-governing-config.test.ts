import { describe, it, expect, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveGoverningTsconfig } from "../../src/project/index.js";
import { collectStaticPreBuildWarnings } from "../../src/harness/index.js";
import { loadTsconfigAliases, resetGoverningDisclosures } from "../../src/project/index.js";

const REFERENCES = path.resolve("fixtures/tsconfig-shapes/project-references");
const JSX_PRESERVE = path.resolve("fixtures/tsconfig-shapes/jsx-preserve");
const BUTTON = path.join(REFERENCES, "src", "components", "Button.tsx");

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mkProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-refs-"));
  cleanupDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

// A create-vite root has empty files+references; the nearest config alone has no paths for @/*.
describe("a references-only config hands over to the referenced config that covers the file", () => {
  it("picks the referenced config whose include covers the component", () => {
    const governing = resolveGoverningTsconfig(BUTTON);

    expect(governing.configPath).toBe(
      path.join(REFERENCES, "tsconfig.app.json").replace(/\\/g, "/"),
    );
    expect(governing.nearestConfigPath).toBe(
      path.join(REFERENCES, "tsconfig.json").replace(/\\/g, "/"),
    );
    expect(governing.viaReferences).toBe(true);
    expect(governing.options.paths).toEqual({ "@/*": ["./src/*"] });
  });

  it("picks the config that covers a file the other referenced config excludes", () => {
    const governing = resolveGoverningTsconfig(path.join(REFERENCES, "vite.config.ts"));

    expect(governing.configPath).toBe(
      path.join(REFERENCES, "tsconfig.node.json").replace(/\\/g, "/"),
    );
    expect(governing.viaReferences).toBe(true);
    expect(governing.options.paths).toBeUndefined();
  });

  it("keeps the nearest config when it declares its own compilerOptions", () => {
    const governing = resolveGoverningTsconfig(path.join(JSX_PRESERVE, "src", "badge.tsx"));

    expect(governing.configPath).toBe(path.join(JSX_PRESERVE, "tsconfig.json").replace(/\\/g, "/"));
    expect(governing.configPath).toBe(governing.nearestConfigPath);
    expect(governing.viaReferences).toBe(false);
  });

  it("returns the nearest config and throws nothing on a reference cycle", () => {
    const dir = mkProject({
      "package.json": JSON.stringify({ name: "cycle" }),
      "tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./tsconfig.a.json" }] }),
      "tsconfig.a.json": JSON.stringify({
        files: [],
        references: [{ path: "./tsconfig.json" }],
      }),
      "src/x.tsx": "export const x = 1;\n",
    });

    const governing = resolveGoverningTsconfig(path.join(dir, "src", "x.tsx"));

    expect(governing.configPath).toBe(governing.nearestConfigPath);
    expect(governing.viaReferences).toBe(false);
  });

  it("returns the nearest config when a referenced target is missing", () => {
    const dir = mkProject({
      "package.json": JSON.stringify({ name: "missing" }),
      "tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./tsconfig.gone.json" }] }),
      "src/x.tsx": "export const x = 1;\n",
    });

    const governing = resolveGoverningTsconfig(path.join(dir, "src", "x.tsx"));

    expect(governing.configPath).toBe(governing.nearestConfigPath);
    expect(governing.viaReferences).toBe(false);
    const sentence = governing.warnings.join(" ");
    expect(sentence).toContain("no referenced config covers");
    // The missing reference target is the one fact this warning exists to report, so it is named.
    expect(sentence).toContain("tsconfig.gone.json (unreadable)");
  });

  it("builds the alias the referenced config declares, so the import resolves", () => {
    // No warnings sink: disclosure is a printing concern; the alias answer must not depend on it.
    const aliases = loadTsconfigAliases(REFERENCES, undefined, BUTTON);
    const entry = aliases.find((a) => a.find.test("@/lib/utils"));

    expect(entry).toBeDefined();
    expect("@/lib/utils".replace(entry!.find, entry!.replacement)).toBe(
      path.join(REFERENCES, "src", "lib", "utils").replace(/\\/g, "/"),
    );
  });
});

// The chosen config differs from the README's nearest-one-wins story, so the run must name it.
describe("the chosen referenced config is disclosed once", () => {
  // The disclosure register is process-global; reset isolates this file's calls per test.
  beforeEach(() => {
    resetGoverningDisclosures();
  });
  it("names the nearest config, the chosen config and the field it supplied", () => {
    const preBuild = collectStaticPreBuildWarnings(REFERENCES, { componentPath: BUTTON });
    const disclosures = preBuild.warnings.filter((w) =>
      w.includes("declares no compilerOptions and lists references"),
    );

    expect(disclosures).toHaveLength(1);
    expect(disclosures[0]).toContain("tsconfig.json declares no compilerOptions and lists references");
    expect(disclosures[0]).toContain("tsconfig.app.json covers");
    expect(disclosures[0]).toContain("src/components/Button.tsx");
    expect(disclosures[0]).toContain("supplies paths");
  });

  it("prints it once for a second run in the same process", () => {
    collectStaticPreBuildWarnings(REFERENCES, { componentPath: BUTTON });
    const again = collectStaticPreBuildWarnings(REFERENCES, { componentPath: BUTTON });

    expect(
      again.warnings.filter((w) => w.includes("declares no compilerOptions and lists references")),
    ).toEqual([]);
  });

  it("says nothing about references for a project that declares none", () => {
    const preBuild = collectStaticPreBuildWarnings(JSX_PRESERVE, {
      componentPath: path.join(JSX_PRESERVE, "src", "badge.tsx"),
    });

    expect(
      preBuild.warnings.filter((w) => w.includes("lists references")),
    ).toEqual([]);
  });
});
