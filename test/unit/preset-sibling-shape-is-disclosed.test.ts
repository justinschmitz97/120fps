import { describe, it, expect, vi, afterEach } from "vitest";
import path from "node:path";
import { extractPropsDetailed, resetExtractionCache } from "../../src/props/index.js";
import {
  describePresetSibling,
  detectPropPresets,
  loadPropPresets,
  PRESET_SHAPE_WARNING,
} from "../../src/props/index.js";

const DIR = path.resolve("./fixtures/preset-collision");
const fixture = (name: string): string => path.join(DIR, name);

function captureStderr(): { lines: () => string[] } {
  resetExtractionCache();
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return { lines: () => write.mock.calls.map((c) => String(c[0])) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// B1/B2: the sidecar is recognised by shape, not by name alone.
describe("a sibling that carries the preset name without the preset shape", () => {
  it("reports a re-exporting sibling as no-default-export", () => {
    expect(describePresetSibling(fixture("re-export.tsx"))).toEqual({
      path: fixture("re-export.props.tsx"),
      shape: "no-default-export",
    });
  });

  it("reports a named-const sibling as no-default-export", () => {
    expect(describePresetSibling(fixture("named-only.tsx"))).toEqual({
      path: fixture("named-only.props.tsx"),
      shape: "no-default-export",
    });
  });

  it("is not loaded as a preset", () => {
    expect(detectPropPresets(fixture("re-export.tsx"))).toBeUndefined();
    expect(detectPropPresets(fixture("named-only.tsx"))).toBeUndefined();
  });

  it("names the file and the shape it lacks", () => {
    expect(PRESET_SHAPE_WARNING(fixture("re-export.props.tsx"))).toBe(
      `${fixture("re-export.props.tsx")} exists, not a preset: no default-exported object ` +
        "literal (expected `export default { prop: [values] }`)",
    );
  });

  it("reports nothing for a component with no sibling at all", () => {
    expect(describePresetSibling(path.resolve("./fixtures/button.tsx"))).toBeUndefined();
  });
});

// B1: the preferred name is found first, and the older name still loads.
describe("preset lookup by shape", () => {
  it("recognises a <stem>.120fps.props.tsx preset", () => {
    expect(describePresetSibling(fixture("wide.tsx"))).toEqual({
      path: fixture("wide.120fps.props.tsx"),
      shape: "preset",
    });
    expect(detectPropPresets(fixture("wide.tsx"))).toBe(fixture("wide.120fps.props.tsx"));
  });

  it("keeps loading the older <stem>.props.tsx name", () => {
    const legacy = path.resolve("./fixtures/m86/preset-restore.tsx");
    expect(describePresetSibling(legacy)).toEqual({
      path: path.resolve("./fixtures/m86/preset-restore.props.tsx"),
      shape: "preset",
    });
    expect(loadPropPresets(detectPropPresets(legacy)!, DIR)).toBeDefined();
  });

  it("keeps loading the older <stem>.props.ts name", () => {
    const legacy = path.resolve("./fixtures/m44-preset-literal.tsx");
    expect(detectPropPresets(legacy)).toBe(path.resolve("./fixtures/m44-preset-literal.props.ts"));
  });
});

// B2: a remedy never names a file that already exists as something else.
describe("the cap remedy names a file the reader can create", () => {
  it("points at <stem>.120fps.props.tsx when the older name is taken", async () => {
    const stderr = captureStderr();
    await extractPropsDetailed(fixture("re-export.tsx"));
    const cap = stderr.lines().find((line) => line.includes("props were extracted"));
    expect(cap).toContain("Add re-export.120fps.props.tsx to choose the props that matter.");
    expect(cap).not.toContain("Add re-export.props.tsx");
  });

  it("names the preset that is already on disk", async () => {
    const stderr = captureStderr();
    await extractPropsDetailed(fixture("wide.tsx"));
    const cap = stderr.lines().find((line) => line.includes("props were extracted"));
    expect(cap).toContain("Add wide.120fps.props.tsx to choose the props that matter.");
  });

  it("leaves the text unchanged when no sibling exists", async () => {
    const stderr = captureStderr();
    await extractPropsDetailed(path.resolve("./fixtures/collapsed-union-size/ConfirmDialog.tsx"));
    const union = stderr.lines().find((line) => line.includes("is a union of"));
    expect(union).toContain("Add ConfirmDialog.props.tsx to choose a different branch.");
  });
});

// B3 (I7): the warnings a later preset would change are recoverable as data.
describe("extraction warnings are recoverable per component stem", () => {
  it("records the cap warning with its stem and text", async () => {
    resetExtractionCache();
    const extraction = await extractPropsDetailed(fixture("re-export.tsx"));
    const cap = extraction.warningRecords.find((r) => r.kind === "prop-cap");
    expect(cap?.stem).toBe("re-export");
    expect(cap?.text).toContain("props were extracted");
    expect(cap?.text).toContain("re-export.120fps.props.tsx");
  });

  it("records a collapsed-union warning", async () => {
    resetExtractionCache();
    const extraction = await extractPropsDetailed(
      path.resolve("./fixtures/collapsed-union-size/ConfirmDialog.tsx"),
    );
    const union = extraction.warningRecords.find((r) => r.kind === "collapsed-union");
    expect(union?.stem).toBe("ConfirmDialog");
    expect(union?.text).toContain('prop "size"');
  });

  it("records a degenerate-prop warning", async () => {
    resetExtractionCache();
    const extraction = await extractPropsDetailed(
      path.resolve("./fixtures/m60/unsynthesizable.tsx"),
    );
    const degenerate = extraction.warningRecords.find((r) => r.kind === "degenerate");
    expect(degenerate?.stem).toBe("unsynthesizable");
    expect(degenerate?.text).toContain("no representative value");
  });

  it("records without a warning sink, where the printed line is deduped away", async () => {
    resetExtractionCache();
    const first = await extractPropsDetailed(fixture("wide.tsx"));
    const second = await extractPropsDetailed(fixture("wide.tsx"));
    expect(first.warningRecords.some((r) => r.kind === "prop-cap")).toBe(true);
    expect(second.warningRecords.some((r) => r.kind === "prop-cap")).toBe(true);
    expect(first.warnings).toEqual([]);
  });
});

// B3 (I7, logto-F4): cap warning shares the sink; a later preset load can re-render it.
describe("the cap warning routed through the warning sink", () => {
  it("reaches the sink instead of stderr when one is passed", async () => {
    const stderr = captureStderr();
    const collected: string[] = [];
    const extraction = await extractPropsDetailed(fixture("re-export.tsx"), {
      onWarning: (message) => collected.push(message),
    });
    expect(extraction.warnings.some((w) => w.includes("props were extracted"))).toBe(true);
    expect(collected.some((w) => w.includes("props were extracted"))).toBe(true);
    expect(stderr.lines().some((line) => line.includes("props were extracted"))).toBe(false);
    // Sink entries render as list lines; a trailing newline leaks a blank line into the JSON.
    expect(collected.some((w) => w.endsWith("\n"))).toBe(false);
    expect(collected[0]?.endsWith("\n")).toBe(false);
  });

  it("still prints to stderr, once, when no sink is passed", async () => {
    const stderr = captureStderr();
    const first = await extractPropsDetailed(fixture("re-export.tsx"));
    const second = await extractPropsDetailed(fixture("re-export.tsx"));
    expect(first.warnings).toEqual([]);
    expect(second.warnings).toEqual([]);
    const printed = stderr.lines().filter((line) => line.includes("props were extracted"));
    expect(printed).toHaveLength(1);
    expect(printed[0]).toBe(`${first.warningRecords.find((r) => r.kind === "prop-cap")?.text}\n`);
  });

  it("records the cap warning even when the sink carries the text", async () => {
    resetExtractionCache();
    const extraction = await extractPropsDetailed(fixture("re-export.tsx"), {
      onWarning: () => {},
    });
    const cap = extraction.warningRecords.find((r) => r.kind === "prop-cap");
    expect(cap?.stem).toBe("re-export");
    expect(extraction.warnings).toContain(cap?.text);
  });
});
