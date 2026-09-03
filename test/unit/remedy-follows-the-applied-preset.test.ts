import { describe, it, expect } from "vitest";
import path from "node:path";
import { explainProps, presetShapeDisclosure } from "../../src/analyze.js";
import { PRESET_SHAPE_WARNING } from "../../src/prop-presets.js";

// radix-themes-F1, epic-stack-F3, logto-F4: a sibling that carries a preset's
// name without its shape was dropped in silence, and the remedy that named it
// asked the user to create a file that was already there.
const DIR = path.resolve("fixtures/preset-collision");
const fixture = (name: string): string => path.join(DIR, name);
const REPO_ROOT = process.cwd();
const relative = (name: string): string =>
  path.relative(REPO_ROOT, fixture(name)).replace(/\\/g, "/");

describe("a sibling that carries a preset's name without its shape", () => {
  it("is disclosed by the dry run, by the path the run rejected", async () => {
    const explained = await explainProps(fixture("re-export.tsx"), {});
    expect(explained.warnings).toContain(PRESET_SHAPE_WARNING(relative("re-export.props.tsx")));
  });

  it("is disclosed exactly once", async () => {
    const explained = await explainProps(fixture("named-only.tsx"), {});
    const hits = explained.warnings.filter((w) => w.includes("exists, not a preset"));
    expect(hits).toHaveLength(1);
  });

  it("names the file and what the run expected to find in it", () => {
    expect(presetShapeDisclosure(fixture("re-export.tsx"), REPO_ROOT)).toBe(
      `${relative("re-export.props.tsx")} exists, not a preset: no default-exported object ` +
        "literal (expected `export default { prop: [values] }`)",
    );
  });

  it("is the same string on the real-run path and the dry-run path", async () => {
    const explained = await explainProps(fixture("named-only.tsx"), {});
    expect(explained.warnings).toContain(
      presetShapeDisclosure(fixture("named-only.tsx"), REPO_ROOT)!,
    );
  });

  it("says nothing about a component with no preset-named sibling", async () => {
    const explained = await explainProps(path.resolve("fixtures/button.tsx"), {});
    expect(explained.warnings.some((w) => w.includes("exists, not a preset"))).toBe(false);
    expect(presetShapeDisclosure(path.resolve("fixtures/button.tsx"), REPO_ROOT)).toBeUndefined();
  });

  it("says nothing about a sibling that is a real preset", async () => {
    const explained = await explainProps(fixture("wide.tsx"), {});
    expect(explained.warnings.some((w) => w.includes("exists, not a preset"))).toBe(false);
    expect(explained.presetPath).toBe(relative("wide.120fps.props.tsx"));
  });
});

describe("an extraction remedy a loaded preset already answers", () => {
  it("is dropped for a prop the preset supplies values for", async () => {
    const explained = await explainProps(fixture("wide.tsx"), {});
    expect(
      explained.warnings.some((w) => w.includes('prop "variant"') && w.includes("union")),
    ).toBe(false);
  });

  it("never asks for a file that is already on disk", async () => {
    const explained = await explainProps(fixture("re-export.tsx"), {});
    expect(explained.warnings.some((w) => w.includes("Add re-export.props.tsx"))).toBe(false);
  });
});
