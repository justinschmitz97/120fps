import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { initFixtureOutcome } from "../../src/pipeline/index.js";
import { buildUncomposedFixtureScaffold, fixtureScaffoldPath } from "../../src/props/index.js";

// radix-themes-F3: --init-fixture must write and report something on the never-composed path.
const COMPONENT = path.resolve("fixtures/uncomposed-bare-alias/panel.tsx");
const TARGET = fixtureScaffoldPath(COMPONENT);
const SIBLINGS = ["PanelRootHeader", "PanelRootBody"];
// The measured file's own exports, the shape analyze() hands the helper.
const EXPORTS = [
  { name: "Panel", isDefault: false },
  { name: "PanelRootHeader", isDefault: false },
  { name: "PanelRootBody", isDefault: false },
];

afterEach(() => {
  if (fs.existsSync(TARGET)) fs.unlinkSync(TARGET);
});

describe("initFixtureOutcome, the helper analyze() calls behind --init-fixture", () => {
  it("writes the scaffold and says where it went", () => {
    const line = initFixtureOutcome(COMPONENT, "Panel", SIBLINGS, EXPORTS);
    expect(line).toBe(
      `wrote fixture scaffold ${TARGET}; edit it to render the real composition, then re-run`,
    );
    expect(fs.existsSync(TARGET)).toBe(true);
  });

  it("writes the bound root and one placeholder per declared sibling", () => {
    initFixtureOutcome(COMPONENT, "Panel", SIBLINGS, EXPORTS);
    const written = fs.readFileSync(TARGET, "utf8");
    expect(written).toContain("<Panel />");
    expect(written).toContain("TODO: place PanelRootHeader");
    expect(written).toContain("TODO: place PanelRootBody");
    expect(written).toContain('import { Panel, PanelRootHeader, PanelRootBody } from "./panel";');
  });

  it("does not overwrite a fixture that is already there, and says so", () => {
    initFixtureOutcome(COMPONENT, "Panel", SIBLINGS, EXPORTS);
    fs.writeFileSync(TARGET, "// edited by hand\n", "utf8");
    const line = initFixtureOutcome(COMPONENT, "Panel", SIBLINGS, EXPORTS);
    expect(line).toBe(`--init-fixture skipped: ${TARGET} already exists`);
    expect(fs.readFileSync(TARGET, "utf8")).toBe("// edited by hand\n");
  });

  it("always returns an outcome line, so the flag never finishes in silence", () => {
    expect(initFixtureOutcome(COMPONENT, "Panel", [], EXPORTS).length).toBeGreaterThan(0);
  });

  it("says why it wrote nothing when the target cannot be written", () => {
    const unwritable = path.resolve("fixtures/no-such-directory-m112/panel.tsx");
    const line = initFixtureOutcome(unwritable, "Panel", SIBLINGS, EXPORTS);
    expect(line).toContain("--init-fixture skipped:");
    expect(line).toContain("could not be written");
    expect(fs.existsSync(fixtureScaffoldPath(unwritable))).toBe(false);
  });
});

describe("the scaffold's import clause", () => {
  it("imports a default-exported root as a default import", () => {
    const source = buildUncomposedFixtureScaffold("panel", "Panel", SIBLINGS, [
      { name: "Panel", isDefault: true },
      { name: "PanelRootHeader", isDefault: false },
      { name: "PanelRootBody", isDefault: false },
    ]);
    expect(source).toContain(
      'import Panel, { PanelRootHeader, PanelRootBody } from "./panel";',
    );
  });

  it("leaves a sibling that is not a same-file export out of the import", () => {
    // M80 (base-ui): sibling is a type-only import elsewhere; importing it here would not resolve.
    const source = buildUncomposedFixtureScaffold("panel", "Panel", ["PanelTab"], [
      { name: "Panel", isDefault: false },
    ]);
    expect(source).toContain('import { Panel } from "./panel";');
    expect(source).not.toContain("PanelTab }");
    expect(source).toContain(
      "TODO: place PanelTab: declared as a type-only import from another file",
    );
  });
});

describe("the scaffold written for a scene nothing could compose", () => {
  it("renders the root inside a fragment when placeholders follow it", () => {
    const source = buildUncomposedFixtureScaffold("panel", "Panel", SIBLINGS, EXPORTS);
    expect(source).toContain("export default function PanelFixture()");
    expect(source).toContain("<>");
    expect(source.indexOf("<Panel />")).toBeLessThan(source.indexOf("TODO: place PanelRootHeader"));
  });

  it("renders the root alone when nothing is left to place", () => {
    const source = buildUncomposedFixtureScaffold("panel", "Panel", [], EXPORTS);
    expect(source).not.toContain("<>");
    expect(source).toContain("<Panel />");
  });
});
