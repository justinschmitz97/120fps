import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  DEFERRED_COMPONENTS_WARNING,
  GENERATED_COMPONENTS_DISCLOSURE,
  GENERATED_MAP_SKIPPED_WARNING,
  deferredComponentsUsedBy,
  isProjectSourceFile,
  readComponentDeclarationMap,
} from "../../src/project/index.js";
import { generateEntry } from "../../src/harness/index.js";

const UNPLUGIN = path.resolve("fixtures/vue-components-map");
const NUXT = path.resolve("fixtures/vue-nuxt-components-map");
const NONE = path.resolve("fixtures/vue-no-generated-map");

const read = (root: string) => readComponentDeclarationMap(root, root);
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

  it("matches a deferred name written as a kebab-case tag", () => {
    expect(deferredComponentsUsedBy("<template><u-carousel /></template>", ["UCarousel"])).toEqual([
      "UCarousel",
    ]);
    expect(deferredComponentsUsedBy("<template><p>hi</p></template>", ["UCarousel"])).toEqual([]);
  });

  it("skips an entry whose module is not on disk and names it", () => {
    const map = read(UNPLUGIN)!;
    expect(map.names.map((entry) => entry.name)).not.toContain("Gone");
    expect(map.skipped).toContain("Gone");
    expect(GENERATED_MAP_SKIPPED_WARNING(map.file, map.skipped)).toContain("Gone");
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
