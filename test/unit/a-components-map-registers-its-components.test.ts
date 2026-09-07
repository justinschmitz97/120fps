import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  DEFERRED_COMPONENTS_WARNING,
  GENERATED_COMPONENTS_DISCLOSURE,
  GENERATED_MAP_SKIPPED_WARNING,
  deferredComponentsUsedBy,
  deferredComponentsWarning,
  isProjectSourceFile,
  readComponentDeclarationMap,
} from "../../src/project/index.js";
import { generateEntry } from "../../src/harness/index.js";

const UNPLUGIN = path.resolve("fixtures/vue-components-map");
const NUXT = path.resolve("fixtures/vue-nuxt-components-map");
const NONE = path.resolve("fixtures/vue-no-generated-map");

const read = (root: string) => readComponentDeclarationMap(root);
const byName = (root: string, name: string) =>
  read(root)!.names.find((entry) => entry.name === name);

describe("reading a components declaration map", () => {
  it("resolves a relative entry to the file on disk", () => {
    const entry = byName(UNPLUGIN, "TheCounter");
    expect(entry?.exportName).toBe("default");
    expect(entry?.targetIsFile).toBe(true);
    expect(path.resolve(entry!.target)).toBe(
      path.join(UNPLUGIN, "src", "components", "TheCounter.vue"),
    );
  });

  it("leaves an entry that resolves inside a dependency unregistered and names it", () => {
    const map = read(UNPLUGIN)!;
    expect(map.names.map((entry) => entry.name)).not.toContain("ElAlert");
    expect(map.deferred).toContain("ElAlert");
    const used = deferredComponentsUsedBy("<template><ElAlert /></template>", map.deferred);
    expect(used).toEqual(["ElAlert"]);
    const text = DEFERRED_COMPONENTS_WARNING(map.file, used, map.deferred.length);
    expect(text).toContain("ElAlert");
    expect(text).toContain("components.d.ts");
    expect(text).toContain("this component's source references");
  });

  it("separates the project's own source from a dependency's by path alone", () => {
    expect(isProjectSourceFile(path.join(UNPLUGIN, "src", "a.vue"), UNPLUGIN)).toBe(true);
    expect(isProjectSourceFile(path.join(UNPLUGIN, "node_modules", "x", "a.vue"), UNPLUGIN)).toBe(
      false,
    );
    expect(isProjectSourceFile(path.join(NONE, "Plain.vue"), UNPLUGIN)).toBe(false);
  });

  it("skips an entry whose module is not on disk and names it", () => {
    const map = read(UNPLUGIN)!;
    expect(map.names.map((entry) => entry.name)).not.toContain("Gone");
    expect(map.skipped).toContain("Gone");
    const text = GENERATED_MAP_SKIPPED_WARNING(map.file, map.skipped);
    expect(text).toContain("Gone");
    expect(text).toContain("entry names a module that is");
  });

  it("puts the plural of the skipped line in the plural", () => {
    expect(GENERATED_MAP_SKIPPED_WARNING("m.d.ts", ["A", "B"])).toContain(
      "entries name modules that are",
    );
  });

  it("reads only the components interface, never another the same file declares", () => {
    const map = read(UNPLUGIN)!;
    const known = [...map.names.map((entry) => entry.name), ...map.skipped, ...map.deferred];
    expect(known).not.toContain("vFocus");
  });

  it("names the map it read", () => {
    const map = read(UNPLUGIN)!;
    expect(path.resolve(map.file)).toBe(path.join(UNPLUGIN, "components.d.ts"));
    expect(GENERATED_COMPONENTS_DISCLOSURE(map.file, map.names.length)).toContain("components.d.ts");
  });

  it("reads a generated Nuxt map of the same shape", () => {
    const map = read(NUXT)!;
    expect(path.resolve(map.file)).toBe(path.join(NUXT, ".nuxt", "components.d.ts"));
    const names = map.names.map((entry) => entry.name);
    expect(names).toContain("Greeting");
    expect(names).toContain("LazyGreeting");
    expect(map.skipped).toContain("Departed");
    expect(path.resolve(byName(NUXT, "Greeting")!.target)).toBe(
      path.join(NUXT, "app", "components", "Greeting.vue"),
    );
  });

  it("reads nothing from a project that has no map", () => {
    expect(read(NONE)).toBeUndefined();
  });
});

describe("deciding which deferred names a component reaches for", () => {
  const deferred = ["Label", "Slot", "UCarousel", "ElAlert", "Transition"];

  // The wg-easy Form/Label.vue shape: the map's names appear only as an import and a Vue built-in.
  const WG_EASY_LABEL = `<template>
  <RLabel :for="props.for" class="md:leading-[2.75rem]">
    <slot />
  </RLabel>
</template>

<script lang="ts" setup>
import { Label as RLabel } from 'reka-ui';

const props = defineProps<{ for: string }>();
</script>
`;

  it("names none of them for a component that only imports and slots", () => {
    expect(deferredComponentsUsedBy(WG_EASY_LABEL, deferred)).toEqual([]);
  });

  it("names a tag the template actually writes", () => {
    expect(
      deferredComponentsUsedBy(
        '<template><UCarousel v-slot="{ item }">{{ item }}</UCarousel></template>',
        deferred,
      ),
    ).toEqual(["UCarousel"]);
  });

  it("matches a deferred name written as a kebab-case tag", () => {
    expect(deferredComponentsUsedBy("<template><u-carousel /></template>", ["UCarousel"])).toEqual([
      "UCarousel",
    ]);
  });

  it("never reads a native element or a Vue built-in as a mapped component", () => {
    const source = "<template><label /><transition><div /></transition><component :is=\"x\" /></template>";
    expect(deferredComponentsUsedBy(source, deferred)).toEqual([]);
  });

  it("ignores a name that only appears in the script as an import", () => {
    const source = `<template><div /></template>
<script setup lang="ts">
import { ElAlert } from 'element-plus';
</script>`;
    expect(deferredComponentsUsedBy(source, deferred)).toEqual([]);
  });

  it("ignores a name the script declares itself", () => {
    const source = `<template><div /></template>
<script setup lang="ts">
const UCarousel = 1;
</script>`;
    expect(deferredComponentsUsedBy(source, deferred)).toEqual([]);
  });

  it("ignores a tag inside a template comment", () => {
    expect(
      deferredComponentsUsedBy("<template><!-- <UCarousel /> --><div /></template>", deferred),
    ).toEqual([]);
  });

  it("ignores a tag written only in the script block", () => {
    const source = `<template><div /></template>
<script setup lang="ts">
const markup = "<UCarousel />";
</script>`;
    expect(deferredComponentsUsedBy(source, deferred)).toEqual([]);
  });

  it("still names a free script binding the map knows", () => {
    const source = `<template><div /></template>
<script setup lang="ts">
const used = UCarousel;
</script>`;
    expect(deferredComponentsUsedBy(source, deferred)).toEqual(["UCarousel"]);
  });
});

describe("the line a deferred entry produces", () => {
  const map = read(UNPLUGIN)!;

  it("prints nothing when the component references no deferred name", () => {
    expect(deferredComponentsWarning("<template><div /></template>", map)).toBeUndefined();
  });

  it("prints one line naming what the component reaches for", () => {
    const line = deferredComponentsWarning("<template><ElAlert /></template>", map);
    expect(line).toContain("ElAlert");
    expect(line).toContain("components.d.ts");
  });

  it("prints nothing for a map with no deferred entry at all", () => {
    expect(
      deferredComponentsWarning("<template><ElAlert /></template>", {
        file: "m.d.ts",
        names: [],
        skipped: [],
        deferred: [],
      }),
    ).toBeUndefined();
  });
});

const vueEntry = (globalComponents?: { name: string; specifier: string; exportName: string }[]) =>
  generateEntry({
    componentRelative: "src/components/Panel.vue",
    componentName: "Panel",
    isDefaultExport: true,
    hasScale: false,
    renderer: "vue",
    ...(globalComponents ? { globalComponents } : {}),
  });

describe("registering mapped components in the Vue entry", () => {
  it("registers each one lazily on the app before it mounts", () => {
    const source = vueEntry([
      { name: "TheCounter", specifier: "/src/components/TheCounter.vue", exportName: "default" },
      { name: "Panel", specifier: "/src/components/Panel.vue", exportName: "default" },
    ]);
    expect(source).toContain("defineAsyncComponent");
    expect(source).toContain('app.component("TheCounter"');
    expect(source).toContain('import("/src/components/TheCounter.vue")');
    expect(source).toContain('app.component("Panel"');
    expect(source.indexOf('app.component("TheCounter"')).toBeLessThan(
      source.indexOf("app.mount(container)"),
    );
  });

  it("reports a registration the browser cannot load instead of rendering nothing quietly", () => {
    const source = vueEntry([
      { name: "TheCounter", specifier: "/src/components/TheCounter.vue", exportName: "default" },
    ]);
    expect(source).toContain("onError:");
    expect(source).toContain("__120fpsComponentLoadFailed");
    expect(source).toContain("[120fps] registered component");
    expect(source).toContain("fail(err)");
  });

  it("leaves the measured component bound to its own module import", () => {
    const source = vueEntry([
      { name: "Panel", specifier: "/src/components/Panel.vue", exportName: "default" },
    ]);
    expect(source).toContain('import * as __120fps_mod from "/src/components/Panel.vue"');
    expect(source).toContain('const Panel = __120fps_selectExport("default")');
    expect(source).toContain("h(Panel, { ...props }");
  });

  it("adds nothing to a Vue entry with no map", () => {
    const source = vueEntry();
    expect(source).not.toContain("app.component(");
    expect(source).not.toContain("defineAsyncComponent");
  });
});
