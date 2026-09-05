import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  explainProps,
  presetAnswersRemedy,
  presetShapeDisclosure,
  remedyNamesLoadedPreset,
} from "../../src/pipeline/index.js";
import { PRESET_SHAPE_WARNING } from "../../src/props/index.js";

// radix-themes-F1, epic-stack-F3, logto-F4: a preset-shaped sibling was dropped silently.
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

  it("is the same string the dry run computes from the shared producer", async () => {
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
  // tone's mixed union must warn; an all-string union would not, hiding a filter that got deleted.
  it("prints for a collapsed union when no preset names the prop", async () => {
    const explained = await explainProps(fixture("no-preset-tone.tsx"), {});
    expect(
      explained.warnings.some((w) => w.includes('prop "tone"') && w.includes("is a union of")),
    ).toBe(true);
  });

  it("is dropped for a prop the preset supplies values for", async () => {
    const explained = await explainProps(fixture("wide.tsx"), {});
    expect(
      explained.warnings.some((w) => w.includes('prop "tone"') && w.includes("is a union of")),
    ).toBe(false);
  });

  it("never asks for a file that is already on disk", async () => {
    const explained = await explainProps(fixture("re-export.tsx"), {});
    expect(explained.warnings.some((w) => w.includes("Add re-export.props.tsx"))).toBe(false);
  });
});

// The real run filters warnings one at a time via extractSchemas, same functions as the dry run.
describe("the real run's own remedy filter", () => {
  const union = (prop: string): string =>
    `Warning: prop "${prop}" in wide.tsx is a union of 2 different shapes ("solid" | ` +
    "{ level: number; }); measured as union. Add wide.props.tsx to choose a different branch.";

  it("answers a remedy whose prop the preset supplies", () => {
    expect(presetAnswersRemedy(union("tone"), ["tone"])).toBe(true);
  });

  it("leaves a remedy for a prop the preset never names", () => {
    expect(presetAnswersRemedy(union("shade"), ["tone"])).toBe(false);
  });

  it("makes a surviving remedy name the preset that is already loaded", () => {
    const rendered = remedyNamesLoadedPreset(union("shade"), "fixtures/wide.120fps.props.tsx");
    expect(rendered).not.toContain("Add wide.props.tsx");
    expect(rendered).toContain("The applied preset fixtures/wide.120fps.props.tsx is already loaded");
    expect(rendered).toContain("to choose a different branch");
  });

  it("leaves a remedy that names no file untouched", () => {
    const other = "Warning: something else entirely happened.";
    expect(remedyNamesLoadedPreset(other, "fixtures/wide.120fps.props.tsx")).toBe(other);
  });
});

// logto-F4: remedy renders after the preset applies, so it never re-asks for the same file.
describe("the capped-extraction remedy in a run that applied a preset", () => {
  it("names the preset the run already loaded", async () => {
    const explained = await explainProps(fixture("wide.tsx"), {});
    const cap = explained.warnings.find((w) => w.includes("measuring the first"));
    expect(cap).toBeDefined();
    expect(cap).toContain(
      `The applied preset ${relative("wide.120fps.props.tsx")} is already loaded; ` +
        "extend it to choose the props that matter.",
    );
  });

  it("asks for no preset file next to a component that has one", async () => {
    const explained = await explainProps(fixture("wide.tsx"), {});
    expect(explained.warnings.some((w) => w.includes("Add wide"))).toBe(false);
  });

  it("names a loaded preset that applied nothing", async () => {
    const explained = await explainProps(fixture("wide-stale.tsx"), {});
    const cap = explained.warnings.find((w) => w.includes("measuring the first"));
    expect(cap).toBeDefined();
    expect(cap).not.toContain("Add ");
    expect(cap).toContain(
      `The applied preset ${relative("wide-stale.120fps.props.tsx")} is already loaded; ` +
        "extend it to choose the props that matter.",
    );
  });

  it("keeps the original wording for a capped component with no preset on disk", async () => {
    const explained = await explainProps(fixture("wide-uncovered.tsx"), {});
    expect(
      explained.warnings.some((w) =>
        w.includes("Add wide-uncovered.props.tsx to choose the props that matter."),
      ),
    ).toBe(true);
  });
});
