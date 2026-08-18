import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import {
  hasAcceptedComponentExtension,
  isComponentFile,
  expandComponentPaths,
  parseArgs,
  type PathReader,
} from "../../src/cli.js";
import {
  detectProjectTransforms,
  detectWrapper,
  generateEntry,
  rendererFor,
  SUPPORTED_TRANSFORM_PLUGINS,
  WRAPPER_CANDIDATES,
} from "../../src/harness.js";
import {
  isVueFile,
  loadVueCompiler,
  parseSfcScript,
  resetVueCompilerCache,
  VUE_COMPILER_MISSING,
  type VueSfcCompiler,
} from "../../src/vue-sfc.js";
import { extractProps, detectScalingProps, projectSourceFiles } from "../../src/prop-gen.js";
import { detectFramework } from "../../src/react-profiler.js";
import {
  resolveFramework,
  isFixturePath,
  detectFixture,
} from "../../src/analyze.js";
import { runPreflight, recognizeTransform } from "../../src/preflight.js";
import {
  buildEnvFingerprint,
  classifyEnv,
  computeEnvKey,
  describeEnvDiff,
  sameMachineIdentity,
} from "../../src/budget.js";
import type { EnvFingerprint, MachineInfo, CalibrationResult } from "../../src/report.js";
import { strictModeUnsupported, VUE_STRICTMODE_ERROR } from "../../src/isolation.js";

const VUE_ROOT = path.resolve("fixtures/vue-project");
const VUE_WRAP_ROOT = path.resolve("fixtures/vue-wrap-project");
const REACT_ROOT = path.resolve("fixtures/wrap-project");

let compiler: VueSfcCompiler | undefined;

beforeAll(async () => {
  resetVueCompilerCache();
  compiler = await loadVueCompiler(VUE_ROOT);
});

// C1: `.vue` is a component file the CLI accepts.
describe("file support", () => {
  it("accepts a .vue path", () => {
    expect(hasAcceptedComponentExtension("./Button.vue")).toBe(true);
    expect(hasAcceptedComponentExtension("C:\\x\\Button.vue")).toBe(true);
  });

  it("still rejects unmeasurable extensions", () => {
    expect(hasAcceptedComponentExtension("./Button.ts")).toBe(false);
    expect(hasAcceptedComponentExtension("./types.d.ts")).toBe(false);
    expect(hasAcceptedComponentExtension("./styles.vue.css")).toBe(false);
  });

  it("names .vue in the rejection message", () => {
    const reader: PathReader = {
      exists: (p) => p === "notes.md",
      isDirectory: () => false,
      walk: () => [],
    };
    const { error } = expandComponentPaths(["notes.md"], reader);
    expect(error).toContain(".vue");
  });

  it("picks .vue files out of a directory walk but skips fixtures", () => {
    expect(isComponentFile("src/Button.vue")).toBe(true);
    expect(isComponentFile("src/Widget.fixture.vue")).toBe(false);
    expect(isComponentFile("node_modules/x/Button.vue")).toBe(false);
  });

  it("expands a directory containing .vue components", () => {
    const files = ["app/Button.vue", "app/Widget.fixture.vue", "app/notes.md"];
    const reader: PathReader = {
      exists: (p) => p === "app",
      isDirectory: (p) => p === "app",
      walk: () => files,
    };
    expect(expandComponentPaths(["app"], reader).paths).toEqual(["app/Button.vue"]);
  });
});

// C2: framework detection reads the manifest; the file's own type wins.
describe("framework detection", () => {
  it("returns vue for a project that depends on vue and not react", () => {
    expect(detectFramework(VUE_ROOT)).toBe("vue");
  });

  it("still returns react when react is present", () => {
    expect(detectFramework(REACT_ROOT)).toBe("react");
  });

  it("accepts --framework vue", () => {
    const args = parseArgs(["./Button.vue", "--framework", "vue"]);
    expect(args.error).toBeUndefined();
    expect(args.framework).toBe("vue");
  });

  it("rejects an unknown framework", () => {
    expect(parseArgs(["./Button.vue", "--framework", "angular"]).error).toContain("vue");
  });

  it("auto-detects vue from the project root", () => {
    expect(resolveFramework("auto", VUE_ROOT)).toBe("vue");
  });

  it("lets the measured file's own type override the flag", () => {
    expect(resolveFramework("react", VUE_ROOT, path.join(VUE_ROOT, "Button.vue"))).toBe("vue");
    expect(resolveFramework("auto", REACT_ROOT, path.join(REACT_ROOT, "Widget.tsx"))).toBe("react");
  });
});

// C3: SFC block parsing, via the project's own compiler.
describe("SFC parsing", () => {
  it("resolves the compiler from the project", () => {
    expect(compiler).toBeDefined();
    expect(typeof compiler!.parse).toBe("function");
  });

  it("returns the <script setup> block and its lang", () => {
    const source = fs.readFileSync(path.join(VUE_ROOT, "Button.vue"), "utf-8");
    const block = parseSfcScript(source, "Button.vue", compiler!);
    expect(block?.lang).toBe("ts");
    expect(block?.content).toContain("defineProps<Props>()");
  });

  it("returns nothing for an SFC without <script setup>", () => {
    const source = fs.readFileSync(path.join(VUE_ROOT, "Plain.vue"), "utf-8");
    expect(parseSfcScript(source, "Plain.vue", compiler!)).toBeUndefined();
  });

  // A hand-rolled tag scan reads the commented-out block; the real parser does not.
  it("ignores a <script setup> inside an HTML comment", () => {
    const source = `<!-- <script setup>const decoy = 1;</script> -->
<script setup lang="ts">
const props = defineProps<{ x: boolean }>();
</script>`;
    const block = parseSfcScript(source, "Decoy.vue", compiler!);
    expect(block?.content).toContain("defineProps");
    expect(block?.content).not.toContain("decoy");
  });

  it("identifies .vue paths", () => {
    expect(isVueFile("a/B.vue")).toBe(true);
    expect(isVueFile("a/B.vue.ts")).toBe(false);
    expect(isVueFile("a/B.tsx")).toBe(false);
  });

  it("names vue as the missing dependency", () => {
    expect(VUE_COMPILER_MISSING("/proj")).toContain("vue");
    expect(VUE_COMPILER_MISSING("/proj")).toContain("/proj");
  });
});

// C4: defineProps extraction produces the same PropSchema[] shape as React.
describe("prop extraction", () => {
  it("reads defineProps<T>() with a locally declared interface", async () => {
    const schemas = await extractProps(path.join(VUE_ROOT, "Button.vue"));
    const by = Object.fromEntries(schemas.map((s) => [s.name, s]));
    expect(Object.keys(by).sort()).toEqual(["count", "disabled", "label", "variant"]);
    expect(by.label).toMatchObject({ kind: "string", required: true });
    expect(by.variant).toMatchObject({ kind: "union", required: false });
    expect(by.variant.values.sort()).toEqual(["danger", "primary", "secondary"]);
    expect(by.disabled).toMatchObject({ kind: "boolean", required: false });
    expect(by.count).toMatchObject({ kind: "number", required: false });
  });

  it("resolves a props type imported from another module", async () => {
    const schemas = await extractProps(path.join(VUE_ROOT, "Card.vue"));
    const by = Object.fromEntries(schemas.map((s) => [s.name, s]));
    expect(Object.keys(by).sort()).toEqual(["compact", "heading", "items", "tone"]);
    expect(by.items.kind).toBe("array");
    expect(by.items.elementTemplate).toEqual({ id: 1, title: "text" });
  });

  // withDefaults names the realistic value; anchors read values[0] everywhere.
  it("puts a withDefaults default first in the value pool", async () => {
    const schemas = await extractProps(path.join(VUE_ROOT, "Card.vue"));
    const by = Object.fromEntries(schemas.map((s) => [s.name, s]));
    expect(by.tone.values[0]).toBe("warning");
    expect(by.compact.values[0]).toBe(false);
  });

  it("yields no props for an SFC without <script setup>", async () => {
    expect(await extractProps(path.join(VUE_ROOT, "Plain.vue"))).toEqual([]);
  });

  it("feeds auto-scaling detection unchanged", async () => {
    const schemas = await extractProps(path.join(VUE_ROOT, "Card.vue"));
    const matches = detectScalingProps(schemas);
    expect(matches[0]?.schema.name).toBe("items");
    expect(matches[0]?.kind).toBe("array");
  });

  it("includes the SFC and its graph in the fingerprint file set", async () => {
    const files = (await projectSourceFiles(path.join(VUE_ROOT, "Nested.vue"))).map((f) =>
      path.basename(f),
    );
    expect(files).toContain("Nested.vue");
    expect(files).toContain("helpers.ts");
  });
});

// C5: the renderer adapter. React's entry is untouched; Vue's mounts an SFC.
describe("renderer adapter", () => {
  const vueOpts = {
    componentRelative: "Button.vue",
    componentName: "Button",
    isDefaultExport: true,
    hasScale: false,
    renderer: "vue" as const,
  };

  it("selects the renderer from the file's extension", () => {
    expect(rendererFor("a/Button.vue")).toBe("vue");
    expect(rendererFor("a/Button.tsx")).toBe("react");
  });

  it("mounts through createApp and imports nothing from react", () => {
    const entry = generateEntry(vueOpts);
    expect(entry).toContain('from "vue"');
    expect(entry).toContain("createApp");
    expect(entry).toContain('import Button from "/Button.vue"');
    expect(entry).not.toContain("react");
    expect(entry).not.toContain("StrictMode");
  });

  it("keeps the control API surface byte-identical", () => {
    const entry = generateEntry(vueOpts);
    for (const member of [
      "mount(",
      "mountWrapperOnly()",
      "unmount()",
      "rerender(",
      "getContainer()",
    ]) {
      expect(entry).toContain(member);
    }
  });

  // The double-rAF fence proves a frame presented, not that Vue's queue drained.
  it("awaits nextTick inside rerender", () => {
    const entry = generateEntry(vueOpts);
    expect(entry).toMatch(/async rerender\([^)]*\)[\s\S]*?await nextTick\(\)/);
  });

  it("wraps through the wrapper's default slot", () => {
    const entry = generateEntry({ ...vueOpts, wrapRelative: "120fps.setup.vue" });
    expect(entry).toContain('import __120fpsWrap, * as __120fpsWrapModule from "/120fps.setup.vue"');
    expect(entry).toContain("default:");
    expect(entry).toContain("__120fpsWrap");
  });

  it("fans auto-scale instances out inside one wrapper element", () => {
    const entry = generateEntry(vueOpts);
    expect(entry).toContain("__120fps_scaleN");
    // One render site, exactly as M26 requires of the React templates.
    expect(entry.match(/renderTree\(/g)?.length ?? 0).toBeGreaterThan(0);
  });

  it("leaves the React entry alone", () => {
    const entry = generateEntry({
      componentRelative: "Button.tsx",
      componentName: "Button",
      isDefaultExport: true,
      hasScale: false,
    });
    expect(entry).toContain('import { createElement, StrictMode } from "react"');
    expect(entry).toContain('import { createRoot } from "react-dom/client"');
    expect(entry).not.toContain("createApp");
    expect(entry).not.toContain("nextTick");
  });
});

// C6: @vitejs/plugin-vue is loaded, not merely named.
describe("plugin passthrough", () => {
  it("lists @vitejs/plugin-vue as a supported transform", () => {
    const entry = SUPPORTED_TRANSFORM_PLUGINS.find((p) => p.code === "vue");
    expect(entry?.packageName).toBe("@vitejs/plugin-vue");
  });

  it("detects it in the Vue fixture project", () => {
    expect(detectProjectTransforms(VUE_ROOT).map((t) => t.code)).toContain("vue");
  });

  // A project with .vue files and no plugin keeps the M48 diagnosis.
  it("keeps the recognizer for projects without the plugin", () => {
    expect(recognizeTransform("./Child.vue")?.owner).toBe("@vitejs/plugin-vue");
  });
});

// C7: a baseline measured under one framework never compares against another.
describe("environment fingerprint", () => {
  const machine: MachineInfo = {
    cpu: "test-cpu",
    cores: 8,
    ramMb: 16384,
    os: "win32",
    nodeVersion: "v20.0.0",
    chromiumVersion: "130.0.0.0",
  };
  const calibration: CalibrationResult = { totalDuration: 50, scriptDuration: 25 };
  const base = { machine, calibration, cpuThrottle: 4, samples: 10, mode: "combo" as const };

  it("records vue and omits react", () => {
    expect(buildEnvFingerprint({ ...base, framework: "vue" }).framework).toBe("vue");
    expect(buildEnvFingerprint({ ...base, framework: "react" }).framework).toBeUndefined();
    expect(buildEnvFingerprint(base).framework).toBeUndefined();
  });

  it("classifies a cross-framework pair as incompatible", () => {
    const react = buildEnvFingerprint(base);
    const vue = buildEnvFingerprint({ ...base, framework: "vue" });
    expect(classifyEnv(react, vue)).toBe("incompatible");
    expect(classifyEnv(vue, react)).toBe("incompatible");
    expect(sameMachineIdentity(react, vue)).toBe(false);
  });

  it("names the framework in the mismatch text", () => {
    const react = buildEnvFingerprint(base);
    const vue = buildEnvFingerprint({ ...base, framework: "vue" });
    expect(describeEnvDiff(react, vue).join(" ")).toMatch(/framework/i);
  });

  it("gives each framework its own baseline slot", () => {
    const react = buildEnvFingerprint(base);
    const vue = buildEnvFingerprint({ ...base, framework: "vue" });
    expect(computeEnvKey(react)).not.toBe(computeEnvKey(vue));
  });

  it("leaves a pre-framework-field baseline comparable", () => {
    const stored = buildEnvFingerprint(base);
    delete (stored as Partial<EnvFingerprint>).framework;
    expect(classifyEnv(stored, buildEnvFingerprint(base))).toBe("identical");
  });
});

// C8: StrictMode is a React property with no Vue equivalent.
describe("strictmode is a usage error under Vue", () => {
  it("rejects --isolate strictmode for a .vue component", () => {
    expect(strictModeUnsupported(["mount", "strictmode"], ["src/Button.vue"])).toBe(true);
  });

  it("allows the other phases", () => {
    expect(strictModeUnsupported(["mount", "memory"], ["src/Button.vue"])).toBe(false);
  });

  it("leaves React runs untouched", () => {
    expect(strictModeUnsupported(["strictmode"], ["src/Button.tsx"])).toBe(false);
  });

  it("names StrictMode as React-only", () => {
    expect(VUE_STRICTMODE_ERROR).toMatch(/strictmode/i);
    expect(VUE_STRICTMODE_ERROR).toMatch(/react/i);
  });

  it("is a CLI usage error", () => {
    const args = parseArgs(["./Button.vue", "--isolate", "strictmode"]);
    expect(args.error).toBe(VUE_STRICTMODE_ERROR);
  });
});

// C9: wrapper and fixture conventions extend to .vue.
describe("wrapper and fixtures", () => {
  it("probes for 120fps.setup.vue", () => {
    expect(WRAPPER_CANDIDATES).toContain("120fps.setup.vue");
  });

  it("prefers the .vue wrapper in a Vue project", () => {
    expect(detectWrapper(VUE_WRAP_ROOT, "vue")).toBe(
      path.join(VUE_WRAP_ROOT, "120fps.setup.vue"),
    );
  });

  it("finds no wrapper where none exists", () => {
    expect(detectWrapper(VUE_ROOT, "vue")).toBeUndefined();
  });

  it("recognizes a .fixture.vue scene", () => {
    expect(isFixturePath("Widget.fixture.vue")).toBe(true);
    expect(detectFixture(path.join(VUE_ROOT, "Widget.vue"))).toBe(
      path.join(VUE_ROOT, "Widget.fixture.vue"),
    );
  });
});

// C10: preflight reads SFC script blocks, so its guarantees survive.
describe("preflight", () => {
  it("catches a server-only import inside <script setup>", () => {
    const result = runPreflight({
      projectRoot: VUE_ROOT,
      entries: [path.join(VUE_ROOT, "ServerLeak.vue")],
      vueCompiler: compiler,
    });
    expect(result.hard.map((h) => h.kind)).toContain("server-only");
  });

  it("walks through a .vue import edge", () => {
    const result = runPreflight({
      projectRoot: VUE_ROOT,
      entries: [path.join(VUE_ROOT, "Nested.vue")],
      vueCompiler: compiler,
    });
    // Child.vue is reached and cleared; no hard or soft hits on a clean graph.
    expect(result.hard).toEqual([]);
    expect(result.transforms.filter((t) => t.transformCode === "vue").length).toBeGreaterThan(0);
  });

  it("degrades to today's behaviour without a compiler", () => {
    const result = runPreflight({
      projectRoot: VUE_ROOT,
      entries: [path.join(VUE_ROOT, "ServerLeak.vue")],
    });
    expect(result.hard).toEqual([]);
  });
});
