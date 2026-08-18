import { describe, it, expect, vi, afterEach } from "vitest";
import path from "node:path";
import {
  extractProps,
  extractAllProps,
  extractExports,
  resetExtractionCache,
} from "../../src/prop-gen.js";
import { detectComponentName } from "../../src/analyze.js";

const M58 = path.resolve("./fixtures/m58");
const fixture = (name: string): string => path.join(M58, name);

const names = async (file: string): Promise<string[]> =>
  (await extractProps(file)).map((s) => s.name).sort();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("M58 hardening", () => {
  // H1 — the file stem names the exported alias, not the local declaration.
  it("H1: matches the file stem against the exported name of an aliased export", async () => {
    expect(await names(fixture("alias-widget.tsx"))).toEqual(["rows", "title"]);
  });

  // H2 — HOC call around the component in the default export position.
  it("H2: follows a HOC wrapper in `export default withTheme(Chart)`", async () => {
    expect(await names(fixture("hoc-default.tsx"))).toEqual([
      "series",
      "stacked",
      "title",
    ]);
  });

  // H3 — generic component signature.
  it("H3: binds a generic component's props", async () => {
    expect(await names("./fixtures/generic.tsx")).toEqual([
      "columns",
      "data",
      "pageSize",
      "striped",
    ]);
  });

  // H4 — two exported components, stem matching neither.
  it("H4: picks the first exported component when the stem matches none", async () => {
    expect(await names("./fixtures/two-exports.tsx")).toEqual(["label", "size"]);
  });

  // H5 — props as interface, type alias and inline literal all bind.
  it("H5: binds inline object-literal props on the target", async () => {
    expect(await names(fixture("inline-props.tsx"))).toEqual(["separator", "trail"]);
  });

  // H6 — the Vue path never reaches the React target resolver.
  it("H6: Vue SFC extraction is unchanged", async () => {
    expect(await names("./fixtures/vue-project/Card.vue")).toEqual([
      "compact",
      "heading",
      "items",
      "tone",
    ]);
  });

  // H7 — class component target behind an internal helper.
  it("H7: binds a class component's type argument over an earlier helper", async () => {
    expect(await names(fixture("class-target.tsx"))).toEqual([
      "caption",
      "max",
      "value",
    ]);
  });

  // H8 — nested wrapper chain around a function expression.
  it("H8: binds through memo(forwardRef(fn))", async () => {
    expect(await names("./fixtures/double-wrap.tsx")).toEqual([
      "disabled",
      "label",
      "variant",
    ]);
  });

  // H9 — a wrapper cycle terminates instead of recursing forever.
  it("H9: a cyclic wrapper alias yields no props and warns", async () => {
    resetExtractionCache();
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(await extractProps(fixture("cycle.tsx"))).toEqual([]);

    const warnings = write.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("Loop"));
    expect(warnings).toHaveLength(1);
  });

  // H10 — self-consistency guard.
  it("H10: prefers the candidate whose keys match the target's destructuring", async () => {
    expect(await names(fixture("wrong-destructure.tsx"))).toEqual(["alpha", "beta"]);
  });

  // H11 — per-export extraction for composition is untouched.
  it("H11: extractAllProps still reports every exported component", async () => {
    const all = await extractAllProps(fixture("hotspot-image.tsx"));
    expect([...all.keys()].sort()).toEqual(["HotspotImage", "Marker"]);
    expect(all.get("Marker")!.map((p) => p.name).sort()).toEqual([
      "isActive",
      "isVisited",
      "spot",
    ]);
  });

  // H12 — a file that exports nothing keeps its first declaration as target.
  it("H12: unexported single component still yields props", async () => {
    expect(await names(fixture("no-exports.tsx"))).toEqual(["alpha", "count"]);
  });

  // H13 — anonymous default function declaration.
  it("H13: binds an anonymous `export default function`", async () => {
    expect(await names(fixture("anon-default.tsx"))).toEqual(["label", "ratio"]);
  });

  // H14 — anonymous default arrow expression.
  it("H14: binds an anonymous `export default (props) => ...`", async () => {
    expect(await names(fixture("anon-arrow.tsx"))).toEqual(["size", "text"]);
  });

  // H15 — React.FC annotation with contextual parameter typing.
  it("H15: binds `const Banner: React.FC<Props>` over an earlier helper", async () => {
    expect(await names(fixture("const-fc.tsx"))).toEqual(["dismissible", "headline"]);
  });

  // H16 — non-component top-level declarations are never candidates.
  it("H16: constants and lowercase exports are not targets", async () => {
    expect(await names("./fixtures/button.tsx")).toEqual([
      "children",
      "disabled",
      "label",
      "onClick",
      "variant",
    ]);
    const exports = await extractExports("./fixtures/button.tsx");
    expect(exports.every((e) => /^[A-Z]/.test(e.name))).toBe(true);
  });

  // H17 — report naming follows the same resolver as the harness import.
  it("H17: componentName follows default exports and export clauses", () => {
    expect(detectComponentName(fixture("panel-default.tsx"))).toBe("Panel");
    expect(detectComponentName(fixture("health-check.tsx"))).toBe("FoodHealthCheck");
    expect(detectComponentName(fixture("colorpicker.tsx"))).toBe("ColorPicker");
    expect(detectComponentName(fixture("class-target.tsx"))).toBe("Gauge");
  });

  // H19 — known gap, asserted so it surfaces the day it is closed: the harness
  // resolver (`detectComponentExport`) compares the raw lowercased stem, so for
  // a file with several exports and a separator in its name it renders its
  // first export while this milestone's resolver binds props to the stem match.
  it("H19: harness naming still uses the un-normalized stem rule", () => {
    expect(detectComponentName(fixture("hotspot-image.tsx"))).toBe("Marker");
    expect(detectComponentName(fixture("alias-widget.tsx"))).toBe("Helper");
  });

  // H20 — the default export wraps a component declared in another module.
  it("H20: `export default memo(Imported)` binds to the imported component", async () => {
    expect(await names(fixture("imported-inner.tsx"))).toEqual(["caption", "weight"]);
  });

  // H18 — the array prop that `--curve` needs comes from the target.
  it("H18: the target's array prop is the one exposed to curve mode", async () => {
    const schemas = await extractProps(fixture("hotspot-image.tsx"));
    expect(schemas.find((s) => s.name === "hotspots")?.kind).toBe("array");
    expect(schemas.find((s) => s.name === "spot")).toBeUndefined();
  });
});
