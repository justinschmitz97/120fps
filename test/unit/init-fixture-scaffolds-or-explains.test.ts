import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { initFixtureOutcome } from "../../src/analyze.js";
import { buildUncomposedFixtureScaffold, fixtureScaffoldPath } from "../../src/composition.js";

// radix-themes-F3: `--init-fixture` was accepted on the never-composed path --
// the path whose own warning recommends it -- and wrote nothing, said nothing.
const COMPONENT = path.resolve("fixtures/uncomposed-bare-alias/panel.tsx");
const TARGET = fixtureScaffoldPath(COMPONENT);
const SIBLINGS = ["PanelRootHeader", "PanelRootBody"];

afterEach(() => {
  if (fs.existsSync(TARGET)) fs.unlinkSync(TARGET);
});

describe("--init-fixture on a component the run could not compose", () => {
  it("writes the scaffold and says where it went", () => {
    const line = initFixtureOutcome(COMPONENT, "Panel", SIBLINGS);
    expect(line).toBe(
      `wrote fixture scaffold ${TARGET}; edit it to render the real composition, then re-run`,
    );
    expect(fs.existsSync(TARGET)).toBe(true);
  });

  it("writes the bound root and one placeholder per declared sibling", () => {
    initFixtureOutcome(COMPONENT, "Panel", SIBLINGS);
    const written = fs.readFileSync(TARGET, "utf8");
    expect(written).toContain("<Panel />");
    expect(written).toContain("TODO: place PanelRootHeader");
    expect(written).toContain("TODO: place PanelRootBody");
    expect(written).toContain('import { Panel, PanelRootHeader, PanelRootBody } from "./panel";');
  });

  it("does not overwrite a fixture that is already there, and says so", () => {
    initFixtureOutcome(COMPONENT, "Panel", SIBLINGS);
    fs.writeFileSync(TARGET, "// edited by hand\n", "utf8");
    const line = initFixtureOutcome(COMPONENT, "Panel", SIBLINGS);
    expect(line).toBe(`--init-fixture skipped: ${TARGET} already exists`);
    expect(fs.readFileSync(TARGET, "utf8")).toBe("// edited by hand\n");
  });

  it("always returns an outcome line, so the flag never finishes in silence", () => {
    expect(initFixtureOutcome(COMPONENT, "Panel", []).length).toBeGreaterThan(0);
  });
});

describe("the scaffold written for a scene nothing could compose", () => {
  it("renders the root inside a fragment when placeholders follow it", () => {
    const source = buildUncomposedFixtureScaffold("panel", "Panel", SIBLINGS);
    expect(source).toContain("export default function PanelFixture()");
    expect(source).toContain("<>");
    expect(source.indexOf("<Panel />")).toBeLessThan(source.indexOf("TODO: place PanelRootHeader"));
  });

  it("renders the root alone when nothing is left to place", () => {
    const source = buildUncomposedFixtureScaffold("panel", "Panel", []);
    expect(source).not.toContain("<>");
    expect(source).toContain("<Panel />");
  });
});
