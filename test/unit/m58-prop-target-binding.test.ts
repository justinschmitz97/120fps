import { describe, it, expect, vi, afterEach } from "vitest";
import path from "node:path";
import {
  extractProps,
  detectScalingProps,
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

describe("M58 target binding: exported component wins over internal helpers", () => {
  it("function helper declared first does not hijack the schema", async () => {
    expect(await names(fixture("colorpicker.tsx"))).toEqual([
      "onChange",
      "presets",
      "value",
    ]);
  });

  it("const-arrow helper declared first does not hijack the schema", async () => {
    expect(await names(fixture("switch-thumb.tsx"))).toEqual([
      "checked",
      "label",
      "size",
    ]);
  });

  it("memo-wrapped export binds to the wrapped function's props", async () => {
    expect(await names(fixture("memo-card.tsx"))).toEqual([
      "compact",
      "rows",
      "title",
    ]);
  });

  it("`export default <Identifier>` binds to the referenced declaration", async () => {
    expect(await names(fixture("panel-default.tsx"))).toEqual([
      "collapsed",
      "files",
      "heading",
    ]);
  });

  it("`export { X as default }` binds to X, not to an earlier helper", async () => {
    expect(await names(fixture("health-check.tsx"))).toEqual(["items", "strict"]);
  });

  it("kebab-case filename resolves to the PascalCase export over an earlier export", async () => {
    expect(await names(fixture("hotspot-image.tsx"))).toEqual([
      "hotspots",
      "src",
      "zoom",
    ]);
  });

  it("memo(Identifier) default export follows the identifier to its declaration", async () => {
    expect(await names("./fixtures/memo-comp.tsx")).toEqual([
      "count",
      "variant",
      "visible",
    ]);
  });
});

describe("M58 target binding: unresolvable target", () => {
  it("returns no props and warns instead of using another declaration's schema", async () => {
    resetExtractionCache();
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const schemas = await extractProps(fixture("table-untyped.tsx"));

    expect(schemas).toEqual([]);
    const warnings = write.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("Table"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("table-untyped.tsx");
  });

  it("warns once per target across repeated extractions", async () => {
    resetExtractionCache();
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await extractProps(fixture("table-untyped.tsx"));
    await extractProps(fixture("table-untyped.tsx"));

    const warnings = write.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("Table"));
    expect(warnings).toHaveLength(1);
  });

  it("a propless target in a file with prop-carrying helpers warns nothing", async () => {
    resetExtractionCache();
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(await extractProps(fixture("propless-target.tsx"))).toEqual([]);
    expect(write.mock.calls.map((c) => String(c[0]))).toEqual([]);
  });
});

describe("M58 target binding: downstream effects", () => {
  it("the target's array prop is visible to scaling detection", async () => {
    const matches = detectScalingProps(await extractProps(fixture("colorpicker.tsx")));
    expect(matches.map((m) => m.schema.name)).toContain("presets");
  });

  it("componentName resolves to the exported name, not the filename", () => {
    expect(detectComponentName(fixture("health-check.tsx"))).toBe("FoodHealthCheck");
  });
});
