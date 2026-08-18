import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  runPreflight,
  recognizeTransform,
  TRANSFORM_RECOGNIZERS,
  PROJECT_TRANSFORM_WARNING,
  transformFailureNote,
} from "../../src/preflight.js";
import {
  detectProjectTransforms,
  stripServerHooks,
  SUPPORTED_TRANSFORM_PLUGINS,
} from "../../src/harness.js";

const ROOT = path.resolve("fixtures/m42-server");
const PROJECT = path.resolve("fixtures/transform-project");

function check(file: string) {
  return runPreflight({ projectRoot: ROOT, entries: [path.join(ROOT, file)] });
}

// C1: detection reads the project's own manifest.
describe("transform detection", () => {
  it("finds the plugins the fixture project declares", () => {
    const codes = detectProjectTransforms(PROJECT).map((t) => t.code).sort();
    expect(codes).toEqual(["svgr", "vanilla-extract"]);
  });

  it("finds none in a project that declares none", () => {
    expect(detectProjectTransforms(path.resolve("fixtures/m42-server"))).toEqual([]);
  });

  it("finds none when the manifest is unreadable", () => {
    expect(detectProjectTransforms(path.resolve("does-not-exist"))).toEqual([]);
  });

  it("keeps every supported entry addressable by its recognizer code", () => {
    for (const entry of SUPPORTED_TRANSFORM_PLUGINS) {
      expect(entry.code).toMatch(/^[a-z-]+$/);
      expect(entry.packageName.length).toBeGreaterThan(0);
    }
  });
});

// C2: server hooks never reach the harness's server.
describe("hook stripping", () => {
  it("removes the hooks that would reach into the harness server", () => {
    const stripped = stripServerHooks({
      name: "p",
      transform: () => undefined,
      configureServer: () => undefined,
      handleHotUpdate: () => undefined,
      hotUpdate: () => undefined,
      configurePreviewServer: () => undefined,
    }) as Record<string, unknown>;

    expect(stripped.transform).toBeTypeOf("function");
    expect(stripped.configureServer).toBeUndefined();
    expect(stripped.handleHotUpdate).toBeUndefined();
    expect(stripped.hotUpdate).toBeUndefined();
    expect(stripped.configurePreviewServer).toBeUndefined();
  });

  it("leaves a plugin without those hooks untouched", () => {
    const plugin = { name: "p", transform: () => undefined };
    expect(stripServerHooks(plugin)).toEqual(plugin);
  });

  it("passes non-objects through", () => {
    expect(stripServerHooks(null)).toBe(null);
    expect(stripServerHooks(undefined)).toBe(undefined);
  });
});

// C1: the recognizer names the plugin family, not the symptom.
describe("transform recognition", () => {
  it("recognizes an SVGR import", () => {
    expect(recognizeTransform("./icon.svg?react")?.code).toBe("svgr");
  });

  it("recognizes a vanilla-extract stylesheet imported directly", () => {
    expect(recognizeTransform("./styles.css.ts")?.code).toBe("vanilla-extract");
  });

  // The specifier alone cannot say: vanilla-extract is imported as
  // "./styles.css" while the file on disk is "styles.css.ts".
  it("recognizes one imported the way vanilla-extract is actually written", () => {
    expect(recognizeTransform("./styles.css", path.join(ROOT, "uses-vanilla-extract.tsx"))?.code)
      .toBe("vanilla-extract");
  });

  it("does not claim a plain stylesheet with no such sibling", () => {
    expect(recognizeTransform("./plain.css", path.join(ROOT, "clean.tsx"))).toBeUndefined();
  });

  it("recognizes a preprocessor stylesheet", () => {
    expect(recognizeTransform("./theme.scss")?.code).toBe("css-preprocessor");
    expect(recognizeTransform("./theme.less")?.code).toBe("css-preprocessor");
  });

  it("recognizes GraphQL, MDX, Vue and Svelte modules", () => {
    expect(recognizeTransform("./q.graphql")?.code).toBe("graphql");
    expect(recognizeTransform("./doc.mdx")?.code).toBe("mdx");
    expect(recognizeTransform("./App.vue")?.code).toBe("vue");
    expect(recognizeTransform("./App.svelte")?.code).toBe("svelte");
  });

  it("leaves ordinary imports alone", () => {
    for (const specifier of ["react", "./Button", "./Button.tsx", "node:fs"]) {
      expect(recognizeTransform(specifier)).toBeUndefined();
    }
  });

  it("gives every recognizer a stable code and an owner", () => {
    for (const entry of TRANSFORM_RECOGNIZERS) {
      expect(entry.code).toMatch(/^[a-z-]+$/);
      expect(entry.owner.length).toBeGreaterThan(0);
    }
  });
});

// C2: recognition happens on the preflight walk, and is never fatal.
describe("preflight reporting", () => {
  it("reports an SVGR import as a transform, not a failure", () => {
    const result = check("uses-svgr.tsx");
    expect(result.hard).toEqual([]);
    expect(result.transforms.map((h) => h.transformCode)).toEqual(["svgr"]);
    expect(result.transforms[0].chain).toEqual(["uses-svgr.tsx"]);
  });

  it("reports a vanilla-extract import", () => {
    expect(check("uses-vanilla-extract.tsx").transforms.map((h) => h.transformCode))
      .toEqual(["vanilla-extract"]);
  });

  it("reports nothing for a component that needs no plugin", () => {
    expect(check("clean.tsx").transforms).toEqual([]);
  });
});

// C3: the message is the deliverable.
describe("messages", () => {
  it("names the import, the owner, and why the harness lacks it", () => {
    const warning = PROJECT_TRANSFORM_WARNING(check("uses-svgr.tsx").transforms[0]);
    expect(warning).toContain("[transform:svgr]");
    expect(warning).toContain("icon.svg?react");
    expect(warning).toContain("vite-plugin-svgr");
    expect(warning).toContain("vite.config");
  });

  it("carries a machine-greppable code so the real distribution can be measured", () => {
    expect(PROJECT_TRANSFORM_WARNING(check("uses-svgr.tsx").transforms[0]))
      .toMatch(/\[transform:[a-z-]+\]/);
  });

  it("appends a note listing every unbuildable import", () => {
    const note = transformFailureNote([
      ...check("uses-svgr.tsx").transforms,
      ...check("uses-vanilla-extract.tsx").transforms,
    ]);
    expect(note).toContain("icon.svg?react");
    expect(note).toContain("styles.css");
    expect(note).toContain("does not load your vite.config");
  });
});
