import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  generateEntry,
  detectComponentExport,
  detectProjectTransforms,
  scanExternalDeps,
  sfcProducesComponent,
  vueComponentName,
  SFC_NO_COMPONENT,
} from "../../src/harness.js";
import {
  loadVueCompiler,
  parseSfcScript,
  resetVueCompilerCache,
  type VueSfcCompiler,
} from "../../src/vue-sfc.js";
import {
  detectScalingProps,
  extractProps,
  projectSourceFiles,
  resetExtractionCache,
} from "../../src/prop-gen.js";
import { generateScalingCombos } from "../../src/prop-gen-values.js";
import { applyPropPresets, loadPropPresets, detectPropPresets } from "../../src/prop-presets.js";
import { runPreflight, recognizeTransform } from "../../src/preflight.js";
import { computeSourceFingerprint } from "../../src/budget.js";
import { strictModeUnsupported } from "../../src/isolation.js";
import { withProductionResolution } from "../node-resolution.js";

const VUE = path.resolve("fixtures/vue-project");
const NOPLUGIN = path.resolve("fixtures/vue-noplugin");

let compiler: VueSfcCompiler | undefined;

beforeAll(async () => {
  compiler = await loadVueCompiler(VUE);
});

function entry(componentRelative: string, extra: Record<string, unknown> = {}): string {
  return generateEntry({
    componentRelative,
    componentName: vueComponentName(componentRelative),
    isDefaultExport: true,
    hasScale: false,
    renderer: "vue",
    ...extra,
  } as Parameters<typeof generateEntry>[0]);
}

// H1: Vue's own file convention is kebab-case, which is not an identifier.
describe("H1: kebab-case SFC filenames", () => {
  it("derives a valid identifier", () => {
    expect(vueComponentName("a/my-button.vue")).toBe("MyButton");
    expect(vueComponentName("a/base_input.vue")).toBe("BaseInput");
    expect(vueComponentName("a/the.thing.vue")).toBe("TheThing");
  });

  it("reaches the entry as a real import binding", () => {
    const src = entry("my-button.vue");
    expect(src).toContain('import MyButton from "/my-button.vue"');
    expect(src).toContain("h(MyButton,");
    expect(src).not.toContain("my-button from");
  });

  it("is what detectComponentExport reports", () => {
    expect(detectComponentExport(path.join(VUE, "my-button.vue"))).toEqual({
      name: "MyButton",
      isDefaultOnly: true,
    });
  });
});

// H2: a leading digit is not a valid identifier start.
describe("H2: filenames that cannot start an identifier", () => {
  it("prefixes rather than emitting a syntax error", () => {
    expect(vueComponentName("a/2col.vue")).toBe("Component2col");
    expect(vueComponentName("a/-.vue")).toBe("Component");
  });
});

// H3: an SFC with <script setup> but no defineProps.
describe("H3: no defineProps", () => {
  it("extracts nothing and stays mountable", async () => {
    expect(await extractProps(path.join(VUE, "NoProps.vue"))).toEqual([]);
  });
});

// H4: the runtime object form carries no types (ADR 0002).
describe("H4: runtime defineProps", () => {
  it("extracts nothing rather than guessing", async () => {
    expect(await extractProps(path.join(VUE, "RuntimeProps.vue"))).toEqual([]);
  });
});

// H5: Vue requires array/object defaults to be factories.
describe("H5: factory defaults in withDefaults", () => {
  it("reads through the arrow body to the literal", async () => {
    const schemas = await extractProps(path.join(VUE, "Defaults.vue"));
    const by = Object.fromEntries(schemas.map((s) => [s.name, s]));
    expect(by.rows.values[0]).toEqual(["alpha", "beta"]);
    expect(by.meta.values[0]).toEqual({ kind: "note" });
    expect(by.title.values[0]).toBe("untitled");
  });

  it("keeps the synthesized pool behind the default", async () => {
    const schemas = await extractProps(path.join(VUE, "Defaults.vue"));
    const rows = schemas.find((s) => s.name === "rows")!;
    expect(rows.values.length).toBeGreaterThan(1);
    expect(rows.kind).toBe("array");
  });
});

// H6: an inline type literal, not a named interface.
describe("H6: inline props type", () => {
  it("resolves the same way", async () => {
    const schemas = await extractProps(path.join(VUE, "Text.vue"));
    // M84: PropSchema gained an additive `provenance` field, populated for
    // every schema; a plain "test" placeholder string carries "placeholder".
    expect(schemas).toEqual([
      { name: "text", kind: "string", required: true, values: ["test"], provenance: "placeholder" },
    ]);
  });
});

// H7: tsconfig `paths` must resolve from the virtual script.
describe("H7: aliased prop types", () => {
  it("resolves a props type imported through a tsconfig alias", async () => {
    const schemas = await extractProps(path.join(VUE, "Aliased.vue"));
    expect(schemas.map((s) => s.name).sort()).toEqual(["compact", "heading", "items", "tone"]);
  });
});

// H8: a <script> block that produces no component fails module evaluation in
// the browser; the run must say so before booting anything.
describe("H8: SFCs that produce no component", () => {
  it("recognizes a plain script with no default export", () => {
    const src = fs.readFileSync(path.join(VUE, "Broken.vue"), "utf-8");
    expect(sfcProducesComponent(src, "Broken.vue", compiler!)).toBe(false);
  });

  it("accepts a template-only SFC", () => {
    const src = fs.readFileSync(path.join(VUE, "Plain.vue"), "utf-8");
    expect(sfcProducesComponent(src, "Plain.vue", compiler!)).toBe(true);
  });

  it("accepts a plain script that does default-export", () => {
    const src = `<script lang="ts">export const x = 1; export default {};</script>\n<template><i/></template>`;
    expect(sfcProducesComponent(src, "Ok.vue", compiler!)).toBe(true);
  });

  // The shape that looks most correct and fails hardest: the Vue compiler
  // treats an empty <script setup> as absent.
  it("rejects an empty <script setup> next to a named-export script", () => {
    const src = `<script lang="ts">export const viewport = { width: 1 };</script>\n<script setup lang="ts"></script>\n<template><i/></template>`;
    expect(sfcProducesComponent(src, "Empty.vue", compiler!)).toBe(false);
  });

  it("accepts it once <script setup> has content", () => {
    const src = `<script lang="ts">export const viewport = { width: 1 };</script>\n<script setup lang="ts">defineOptions({ name: "X" });</script>\n<template><i/></template>`;
    expect(sfcProducesComponent(src, "Full.vue", compiler!)).toBe(true);
  });

  it("names the file and both fixes", () => {
    const message = SFC_NO_COMPONENT("src/Broken.vue");
    expect(message).toContain("src/Broken.vue");
    expect(message).toContain("export default");
    expect(message).toContain("<script setup>");
  });
});

// H9: preflight has to see through an SFC edge, or every guarantee below the
// measured file silently becomes a no-op.
describe("H9: preflight through .vue edges", () => {
  it("finds a server-only import one SFC deep", () => {
    const result = runPreflight({
      projectRoot: VUE,
      entries: [path.join(VUE, "LeakParent.vue")],
      vueCompiler: compiler,
    });
    expect(result.hard.map((h) => h.kind)).toContain("server-only");
    const chain = result.hard[0].chain.join(" ");
    expect(chain).toContain("LeakParent.vue");
    expect(chain).toContain("ServerLeak.vue");
  });

  it("does not walk out of the project through node_modules", () => {
    const result = runPreflight({
      projectRoot: VUE,
      entries: [path.join(VUE, "Nested.vue")],
      vueCompiler: compiler,
    });
    expect(result.hard).toEqual([]);
  });
});

// H10: a `</script>` sequence inside the script block.
describe("H10: script-block boundaries", () => {
  it("ends the block where the browser would", () => {
    const src = `<script setup lang="ts">\nconst s = "a";\n</script>\n<template><i>{{ s }}</i></template>`;
    expect(parseSfcScript(src, "S.vue", compiler!)?.content.trim()).toBe('const s = "a";');
  });

  it("reads a generic attribute containing a quoted >", () => {
    const src = `<script setup lang="ts" generic="T extends { a: string }">\nconst props = defineProps<{ rows: T[] }>();\n</script>\n<template><i/></template>`;
    expect(parseSfcScript(src, "G.vue", compiler!)?.content).toContain("defineProps");
  });
});

// H11: auto-scale must fan out inside one wrapper element (M26).
describe("H11: auto-scale fan-out", () => {
  it("renders N instances in one element", () => {
    const src = entry("Text.vue");
    expect(src).toContain('h("div", null, Array.from({ length: props.__120fps_scaleN }');
    // Wrapped once, not per instance.
    expect(src.match(/renderTree\(/g)?.length).toBe(1);
  });

  // A manual `scale(n)` export lives in the SFC's plain <script> block and
  // returns a VNode; the entry dispatches to it instead of fanning out.
  it("dispatches to a manual scale export when one exists", () => {
    const src = generateEntry({
      componentRelative: "Grid.vue",
      componentName: "Grid",
      isDefaultExport: true,
      hasScale: true,
      renderer: "vue",
    });
    expect(src).toContain('import Grid, { scale as __120fps_scale } from "/Grid.vue"');
    expect(src).toContain("return __120fps_scale(props.__120fps_scaleN);");
    expect(src).not.toContain("Array.from({ length:");
  });

  it("still produces scaling combos from an array prop", async () => {
    const schemas = await extractProps(path.join(VUE, "Card.vue"));
    const match = detectScalingProps(schemas)[0];
    const combos = generateScalingCombos(schemas, match, [1, 5]);
    expect(combos).toHaveLength(2);
    expect((combos[0].items as unknown[]).length).toBe(1);
    expect((combos[1].items as unknown[]).length).toBe(5);
  });
});

// H12: presets are a prop-schema concern, so they reach Vue for free.
describe("H12: prop presets on a .vue component", () => {
  it("is detected next to the SFC", () => {
    expect(detectPropPresets(path.join(VUE, "Card.vue"))).toBe(path.join(VUE, "Card.props.ts"));
  });

  it("replaces the synthesized pool", async () => {
    const presets = loadPropPresets(path.join(VUE, "Card.props.ts"), VUE)!;
    const applied = applyPropPresets(await extractProps(path.join(VUE, "Card.vue")), presets);
    const by = Object.fromEntries(applied.schemas.map((s) => [s.name, s]));
    expect(by.heading.values).toEqual(["Inbox", "Archive"]);
    expect(by.items.values).toEqual([[{ id: 7, title: "real row" }]]);
    expect(applied.unknown).toEqual([]);
  });
});

// H13: the M39 fingerprint must move when the SFC does.
describe("H13: source fingerprint tracks the SFC", () => {
  const scratch = path.join(VUE, "tmp-fingerprint");
  const sfc = path.join(scratch, "Scratch.vue");

  beforeAll(() => {
    fs.mkdirSync(scratch, { recursive: true });
  });
  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("changes when the script block changes", async () => {
    const write = (label: string) =>
      fs.writeFileSync(
        sfc,
        `<script setup lang="ts">\ndefineProps<{ ${label}: string }>();\n</script>\n<template><i/></template>`,
      );

    write("one");
    resetExtractionCache();
    const before = computeSourceFingerprint(VUE, await projectSourceFiles(sfc), "cfg");

    write("two");
    resetExtractionCache();
    const after = computeSourceFingerprint(VUE, await projectSourceFiles(sfc), "cfg");

    expect(before).not.toBe(after);
  });

  it("lists the .vue file itself, never the virtual script", async () => {
    fs.writeFileSync(
      sfc,
      `<script setup lang="ts">\ndefineProps<{ one: string }>();\n</script>\n<template><i/></template>`,
    );
    resetExtractionCache();
    const files = await projectSourceFiles(sfc);
    expect(files.some((f) => f.endsWith("Scratch.vue"))).toBe(true);
    expect(files.some((f) => f.endsWith(".vue.ts"))).toBe(false);
  });
});

// H14: a project with .vue files and no plugin keeps the M48 diagnosis.
describe("H14: Vue project without @vitejs/plugin-vue", () => {
  it("loads no vue transform", () => {
    expect(detectProjectTransforms(NOPLUGIN).map((t) => t.code)).not.toContain("vue");
  });

  it("still recognizes the import and names the plugin", () => {
    const result = runPreflight({
      projectRoot: NOPLUGIN,
      entries: [path.join(NOPLUGIN, "Uses.tsx")],
    });
    const hit = result.transforms.find((t) => t.transformCode === "vue");
    expect(hit?.transformOwner).toBe("@vitejs/plugin-vue");
    expect(recognizeTransform("./Lonely.vue")?.code).toBe("vue");
  });
});

// H15: no vue at all: extraction degrades rather than throwing.
describe("H15: Vue compiler unavailable", () => {
  // vitest exports NODE_PATH into pnpm's hoisted store, so every package
  // resolves from everywhere inside a test process; a failed resolution is only
  // observable with it removed. Both specifiers are probed synchronously before
  // the first await, so wrapping the call is enough.
  it("resolves to undefined outside a Vue project", async () => {
    resetVueCompilerCache();
    // Filesystem root, not "C:/": that literal is a relative path on POSIX and
    // would probe the repo's own node_modules.
    const loaded = await withProductionResolution(() =>
      loadVueCompiler(path.parse(process.cwd()).root),
    );
    expect(loaded).toBeUndefined();
    resetVueCompilerCache();
  });

  it("extracts nothing rather than throwing", async () => {
    resetVueCompilerCache();
    const schemas = await withProductionResolution(() =>
      extractProps(path.join(NOPLUGIN, "Lonely.vue")),
    );
    expect(schemas).toEqual([]);
    resetVueCompilerCache();
    compiler = await loadVueCompiler(VUE);
  });
});

// H16: only strictmode is refused; the other isolation phases are fine.
describe("H16: isolation phases under Vue", () => {
  it("allows every phase but strictmode", () => {
    for (const phase of ["mount", "rerender", "unmount", "memory"]) {
      expect(strictModeUnsupported([phase], ["a/B.vue"])).toBe(false);
    }
    expect(strictModeUnsupported(["mount", "strictmode"], ["a/B.vue"])).toBe(true);
  });

  it("refuses a mixed sweep containing one .vue path", () => {
    expect(strictModeUnsupported(["strictmode"], ["a/B.tsx", "a/C.vue"])).toBe(true);
  });
});

// H17: the M25 stylesheet block leads the Vue entry too.
describe("H17: stylesheet injection into the Vue entry", () => {
  it("imports the stylesheet before the runtime and the component", () => {
    const src = entry("Button.vue", { cssImports: ["/app/globals.css"] });
    const css = src.indexOf('import "/app/globals.css";');
    const runtime = src.indexOf('from "vue"');
    const component = src.indexOf('from "/Button.vue"');
    expect(css).toBeGreaterThanOrEqual(0);
    expect(css).toBeLessThan(runtime);
    expect(runtime).toBeLessThan(component);
  });
});

// H18: local .vue imports must be followed when pre-populating optimizeDeps.
describe("H18: dependency scanning through SFCs", () => {
  it("follows a relative .vue import and collects real packages", () => {
    const deps = scanExternalDeps(path.join(VUE, "Nested.vue"), VUE, []);
    // `vue` is declared by the renderer list, and the walk must not leave the
    // project through Child.vue.
    expect(deps).not.toContain("./Child.vue");
    expect(deps.every((d) => !d.startsWith("."))).toBe(true);
  });
});

// H19: an SFC whose setup throws must not read as a silent pass.
describe("H19: a throwing SFC", () => {
  it("still extracts its declared props", async () => {
    const schemas = await extractProps(path.join(VUE, "Throws.vue"));
    expect(schemas.map((s) => s.name)).toEqual(["mode"]);
  });
});

// H20: the React entry is untouched by everything above.
describe("H20: React entry is unchanged", () => {
  it("contains no Vue vocabulary at all", () => {
    const src = generateEntry({
      componentRelative: "Button.tsx",
      componentName: "Button",
      isDefaultExport: false,
      hasScale: true,
      wrapRelative: "120fps.setup.tsx",
      cssImports: ["/app/globals.css"],
    });
    for (const token of ["createApp", "nextTick", "shallowRef", "h(", "default: () =>"]) {
      expect(src).not.toContain(token);
    }
    expect(src).toContain("createRoot(container)");
    expect(src).toContain("__120fpsInStrict");
  });
});
