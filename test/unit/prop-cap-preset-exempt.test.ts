import { describe, it, expect, vi, afterEach } from "vitest";
import path from "node:path";
import { extractProps, resetExtractionCache } from "../../src/prop-gen.js";
import { detectPropPresets, loadPropPresets, applyPropPresets } from "../../src/prop-presets.js";

const M86 = path.resolve("./fixtures/m86");
const fixture = (name: string): string => path.join(M86, name);

function captureStderr(): { lines: () => string[] } {
  resetExtractionCache();
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return { lines: () => write.mock.calls.map((c) => String(c[0])) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// M86 MUST: a <stem>.props.tsx preset can name a prop the cap dropped and
// have it restored to the measured schema.
describe("M86: a preset-named prop is exempt from the cap", () => {
  it("onKeyDown (purely inherited, unreferenced, unrequired) is present in the schema", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("preset-restore.tsx"));
    const names = schemas.map((s) => s.name);
    expect(names).toContain("onKeyDown");
  });

  it("applyPropPresets applies the preset's values to the restored prop", async () => {
    resetExtractionCache();
    const target = fixture("preset-restore.tsx");
    const schemas = await extractProps(target);
    const presetPath = detectPropPresets(target)!;
    const presets = loadPropPresets(presetPath, M86)!;
    const { schemas: applied, applied: appliedNames, unknown } = applyPropPresets(schemas, presets);
    expect(appliedNames).toContain("onKeyDown");
    expect(unknown).toEqual([]);
    const onKeyDown = applied.find((s) => s.name === "onKeyDown");
    expect(onKeyDown?.provenance).toBe("preset");
  });
});

// M86 MUST NOT: report "not a prop of the measured component" for a prop
// that IS a prop and was merely truncated.
describe("M86 MUST NOT: no false 'not a prop' warning for a cap-truncated-but-restored prop", () => {
  it("no UNKNOWN_PRESET_PROPS_WARNING fires for onKeyDown", async () => {
    resetExtractionCache();
    const target = fixture("preset-restore.tsx");
    const schemas = await extractProps(target);
    const presetPath = detectPropPresets(target)!;
    const presets = loadPropPresets(presetPath, M86)!;
    const { unknown } = applyPropPresets(schemas, presets);
    expect(unknown).not.toContain("onKeyDown");
  });
});
