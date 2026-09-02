import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPreflight, PROJECT_TRANSFORM_WARNING } from "../../src/preflight.js";
import { presentBundlerFailure } from "../../src/harness.js";

// hoppscotch-F2: `~icons/lucide/eye` has no file behind it; the run fell through
// to the generic unresolved-import remedy ("run that package's own build
// first"), which names a build the repository does not have. documenso-F1:
// `@lingui/react/macro` is a Babel macro the real app compiles away, invisible
// to preflight, so the dry run was clean and the real run died elsewhere.
const FIXTURES = path.resolve(import.meta.dirname, "..", "..", "fixtures");
const VIRTUAL_FIXTURE = path.join(FIXTURES, "virtual-namespace-project");
const MACRO_FIXTURE = path.join(FIXTURES, "macro-import-project");

const HOPPSCOTCH_MESSAGE =
  'Failed to resolve import "~icons/lucide/eye" from "src/components/smart/EnvInput.vue". Does the file exist?';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-virtual-macro-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("a virtual-namespace import", () => {
  it("is a project-transform preflight hit naming the declared producer", () => {
    const result = runPreflight({
      projectRoot: VIRTUAL_FIXTURE,
      entries: [path.join(VIRTUAL_FIXTURE, "src", "Icon.tsx")],
    });

    const hit = result.transforms.find((h) => h.specifier === "~icons/lucide/eye");
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe("project-transform");
    expect(hit!.transformOwner).toBe("unplugin-icons");
  });

  it("warns about the plugin the harness does not load, with no build command", () => {
    const result = runPreflight({
      projectRoot: VIRTUAL_FIXTURE,
      entries: [path.join(VIRTUAL_FIXTURE, "src", "Icon.tsx")],
    });
    const warning = PROJECT_TRANSFORM_WARNING(result.transforms[0]);

    expect(warning).toContain("unplugin-icons");
    expect(warning).toContain("vite.config");
    expect(warning).not.toMatch(/build first|run .*build/);
  });

  it("is reported for a namespace no package declares, without naming a package", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "p" }));
    const entry = path.join(tmpDir, "Panel.tsx");
    fs.writeFileSync(entry, `import "virtual:my-plugin/state";\nexport const Panel = 1;\n`);

    const result = runPreflight({ projectRoot: tmpDir, entries: [entry] });
    const hit = result.transforms.find((h) => h.specifier === "virtual:my-plugin/state");
    expect(hit).toBeDefined();
    expect(PROJECT_TRANSFORM_WARNING(hit!)).not.toContain("unplugin-icons");
  });
});

describe("a bundler failure inside a virtual namespace", () => {
  it("names the plugin the repository declares and drops the unbuilt-package clause", () => {
    const presented = presentBundlerFailure(HOPPSCOTCH_MESSAGE, VIRTUAL_FIXTURE, []);

    expect(presented).toContain("unplugin-icons");
    expect(presented).toContain("~icons/lucide/eye");
    expect(presented).not.toContain("run that package's own build first");
  });

  it("states the namespace and nothing more when no declaring package is found", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "p" }));
    const presented = presentBundlerFailure(HOPPSCOTCH_MESSAGE, tmpDir, []);

    expect(presented).toContain("~icons/");
    expect(presented).not.toContain("unplugin-icons");
    expect(presented).not.toContain("run that package's own build first");
  });

  it("keeps the ordinary unresolved-import remedy for a plain specifier", () => {
    const presented = presentBundlerFailure(
      'Failed to resolve import "@shadcn/react/scroller" from "ui/scroller.tsx". Does the file exist?',
      tmpDir,
      [],
    );

    expect(presented).toContain("run that package's own build first");
  });
});

describe("a Babel-macro import", () => {
  it("is a project-transform preflight hit naming the declared macro compiler", () => {
    const result = runPreflight({
      projectRoot: MACRO_FIXTURE,
      entries: [path.join(MACRO_FIXTURE, "src", "Dialog.tsx")],
    });

    const hit = result.transforms.find((h) => h.specifier === "@lingui/react/macro");
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe("project-transform");
    expect(hit!.transformOwner).toBe("vite-plugin-babel-macros");
  });

  it("warns with the specifier and no build command", () => {
    const result = runPreflight({
      projectRoot: MACRO_FIXTURE,
      entries: [path.join(MACRO_FIXTURE, "src", "Dialog.tsx")],
    });
    const warning = PROJECT_TRANSFORM_WARNING(result.transforms[0]);

    expect(warning).toContain("@lingui/react/macro");
    expect(warning).toContain("vite-plugin-babel-macros");
    expect(warning).toContain("vite.config");
    expect(warning).not.toMatch(/build first|run .*build/);
  });
});
