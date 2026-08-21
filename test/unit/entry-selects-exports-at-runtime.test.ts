import { describe, it, expect } from "vitest";
import { generateEntry, generateComposedEntry } from "../../src/harness.js";

const base = {
  componentRelative: "packages/ui/components/icon/Icon.tsx",
  componentName: "Icon",
  isDefaultExport: false,
  hasScale: false,
};

// calcom's `Icon.tsx` re-exports a type as a value (`export { IconName, Icon }`).
// A named ESM import of the export list fails to link at all —
// "does not provide an export named 'IconName'" — before anything renders.
describe("how the generated entry reaches the component's exports", () => {
  it("imports the module as a namespace instead of naming bindings", () => {
    const entry = generateEntry(base);
    expect(entry).toContain('import * as __120fps_mod from "/packages/ui/components/icon/Icon.tsx"');
    expect(entry).not.toContain("import { Icon as Component }");
  });

  it("selects the requested export at runtime", () => {
    expect(generateEntry(base)).toContain('__120fps_selectExport("Icon")');
  });

  it("selects the default export at runtime when the target is the default", () => {
    const entry = generateEntry({ ...base, isDefaultExport: true });
    expect(entry).toContain('__120fps_selectExport("default")');
    expect(entry).not.toContain('import Icon from "/packages/ui');
  });

  it("says a selected export is not a runtime value, and lists the ones that are", () => {
    const entry = generateEntry(base);
    expect(entry).toContain("is not a runtime value (a type-only export?)");
    expect(entry).toContain("Object.keys(__120fps_mod)");
  });

  it("keeps the scale export optional and selected the same way", () => {
    const entry = generateEntry({ ...base, hasScale: true });
    expect(entry).toContain("(__120fps_mod as any).scale");
    expect(entry).not.toContain("scale as __120fps_scale");
  });

  it("does the same for a Vue entry", () => {
    const entry = generateEntry({ ...base, componentRelative: "src/Badge.vue", renderer: "vue" as const });
    expect(entry).toContain('import * as __120fps_mod from "/src/Badge.vue"');
    expect(entry).toContain("is not a runtime value (a type-only export?)");
  });

  it("does the same for a composed scene, keeping every composed name bound", () => {
    const entry = generateComposedEntry(
      "packages/ui/components/icon/Icon.tsx",
      { structure: [{ component: "Icon", props: {}, children: [] }] } as never,
      [{ name: "Icon", isDefault: false }] as never,
    );
    expect(entry).toContain('import * as __120fps_mod from "/packages/ui/components/icon/Icon.tsx"');
    expect(entry).toContain('const Icon = __120fps_selectExport("Icon");');
    expect(entry).toContain("is not a runtime value (a type-only export?)");
  });
});
