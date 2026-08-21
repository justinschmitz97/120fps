import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { generateEntry } from "../../src/harness.js";
import {
  loadVueCompiler,
  resetVueCompilerCache,
  templateHasUnconditionalRoot,
  type VueSfcCompiler,
} from "../../src/vue-sfc.js";

const VUE_ROOT = path.resolve("fixtures/vue-project");

let compiler: VueSfcCompiler | undefined;

beforeAll(async () => {
  resetVueCompilerCache();
  compiler = await loadVueCompiler(VUE_ROOT);
});

// M87: primevue's Accordion.vue crashes with `TypeError: this.$slots.default
// is not a function` because the harness mounts with no slots object at all,
// so `$slots.default` is undefined rather than an empty, callable function.
describe("generateVueEntry: default slot is always callable", () => {
  const opts = {
    componentRelative: "Accordion.vue",
    componentName: "Accordion",
    isDefaultExport: true,
    hasScale: false,
    renderer: "vue" as const,
  };

  it("passes a slots object with a callable default to h()", () => {
    const entry = generateEntry(opts);
    // The component's own h() call site must carry a third (slots) argument
    // whose default entry is a function, not merely an h() call with props
    // as its only argument.
    expect(entry).toMatch(/h\(Accordion,\s*\{\s*\.\.\.props\s*\}\s*,\s*\{\s*default:\s*\(\)\s*=>/);
  });

  it("does not regress when a wrapper is present", () => {
    const entry = generateEntry({ ...opts, wrapRelative: "120fps.setup.vue" });
    expect(entry).toContain("default:");
    expect(entry).toContain("__120fpsWrap");
  });
});

// M87: element-plus's button.vue root is `<component :is="tag">`, unconditional
// -- the combo phase must report nonzero DOM the same way scale-probe already
// does, achieved by wrapping the bare render in the same stable container
// shape scale-probe already uses (proven correct by the N+1 DOM-count pattern
// in the field-test evidence: 2/6/21/51 for N=1/5/20/50).
describe("generateVueEntry: unconditional root renders inside a stable container in the combo phase", () => {
  const baseOpts = {
    componentRelative: "DynamicRoot.vue",
    componentName: "DynamicRoot",
    isDefaultExport: true,
    hasScale: false,
    renderer: "vue" as const,
  };

  it("wraps the bare component render in a container when the root is unconditional", () => {
    const entry = generateEntry({ ...baseOpts, vueUnconditionalRoot: true });
    expect(entry).toMatch(
      /return h\("div",[\s\S]*?\[h\(DynamicRoot,\s*\{\s*\.\.\.props,?\s*\}[\s\S]*?\)\]\)/,
    );
  });

  it("leaves the bare component render unwrapped when the root is conditional (v-if) or unknown, but still callable-slot-safe", () => {
    const entryConditional = generateEntry({ ...baseOpts, vueUnconditionalRoot: false });
    expect(entryConditional).toMatch(
      /return h\(DynamicRoot,\s*\{\s*\.\.\.props\s*\},\s*\{\s*default:\s*\(\)\s*=>/,
    );
    expect(entryConditional).not.toMatch(/return h\("div", null, \[h\(/);

    const entryDefault = generateEntry(baseOpts);
    expect(entryDefault).toMatch(
      /return h\(DynamicRoot,\s*\{\s*\.\.\.props\s*\},\s*\{\s*default:\s*\(\)\s*=>/,
    );
  });

  it("does not change the scale-probe branch, which already wraps", () => {
    const wrapped = generateEntry({ ...baseOpts, vueUnconditionalRoot: true });
    const unwrapped = generateEntry({ ...baseOpts, vueUnconditionalRoot: false });
    const scaleBranch = (s: string) => s.slice(s.indexOf("__120fps_scaleN"), s.indexOf("renderComponent"));
    expect(scaleBranch(wrapped)).toBe(scaleBranch(unwrapped));
  });
});

describe("templateHasUnconditionalRoot", () => {
  it("is true for a plain element root with no directives", () => {
    const source = `<template><component :is="tag" v-bind="props" /></template>\n<script setup lang="ts">defineProps<{tag: string}>();</script>`;
    expect(templateHasUnconditionalRoot(source, "X.vue", compiler!)).toBe(true);
  });

  it("is false when the root carries v-if", () => {
    const source = `<template><div v-if="show">hi</div></template>\n<script setup lang="ts">defineProps<{show: boolean}>();</script>`;
    expect(templateHasUnconditionalRoot(source, "X.vue", compiler!)).toBe(false);
  });

  it("is false when the root carries v-show", () => {
    const source = `<template><div v-show="show">hi</div></template>\n<script setup lang="ts">defineProps<{show: boolean}>();</script>`;
    expect(templateHasUnconditionalRoot(source, "X.vue", compiler!)).toBe(false);
  });

  it("is false when the root carries v-for", () => {
    const source = `<template><li v-for="i in items" :key="i">{{ i }}</li></template>\n<script setup lang="ts">defineProps<{items: number[]}>();</script>`;
    expect(templateHasUnconditionalRoot(source, "X.vue", compiler!)).toBe(false);
  });

  it("is false for an SFC with no <template> block", () => {
    const source = `<script setup lang="ts">defineProps<{x: boolean}>();</script>`;
    expect(templateHasUnconditionalRoot(source, "X.vue", compiler!)).toBe(false);
  });
});
