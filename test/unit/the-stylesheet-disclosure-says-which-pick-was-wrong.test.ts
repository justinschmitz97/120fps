import { describe, it, expect } from "vitest";
import {
  STYLESHEET_FALLBACK_MATCHED_NOTHING_WARNING,
  STYLESHEET_MATCHED_NOTHING_COLLAPSED_WARNING,
  STYLESHEET_MATCHED_NOTHING_WARNING,
  stylesheetMatchWarnings,
} from "../../src/pipeline/index.js";
import { type CssReport } from "../../src/report/index.js";

function sheet(file: string, rules: number, matchedRules: number): NonNullable<CssReport["details"]>[number] {
  return { file, bytes: rules * 20, rules, matchedRules };
}

describe("stylesheets that matched nothing next to one that did", () => {
  const supabase: Pick<CssReport, "layer" | "details"> = {
    layer: "entry-chain",
    details: [
      sheet("styles/globals.css", 85, 28),
      sheet("styles/graphiql-base.css", 120, 0),
      sheet("styles/monaco.css", 40, 0),
      sheet("styles/reactflow.css", 60, 0),
      sheet("styles/stripe.css", 25, 0),
    ],
  };

  it("collapses them into a single line", () => {
    expect(stylesheetMatchWarnings(supabase)).toHaveLength(1);
  });

  it("names how many there were and up to three of them", () => {
    const [line] = stylesheetMatchWarnings(supabase);
    expect(line).toContain("4");
    expect(line).toContain("styles/graphiql-base.css");
    expect(line).toContain("styles/monaco.css");
    expect(line).toContain("styles/reactflow.css");
    expect(line).not.toContain("styles/stripe.css");
  });

  it("does not advise --wrap for a sheet this component was never expected to use", () => {
    expect(stylesheetMatchWarnings(supabase)[0]).not.toContain("--wrap");
  });

  it("says nothing about the sheet that did match", () => {
    expect(stylesheetMatchWarnings(supabase)[0]).not.toContain("styles/globals.css");
  });
});

describe("a largest-stylesheet pick that matched nothing", () => {
  const wrongPick: Pick<CssReport, "layer" | "details"> = {
    layer: "largest-fallback",
    details: [sheet("share/ShareDialog.scss", 214, 0)],
  };

  it("gets its own line", () => {
    expect(stylesheetMatchWarnings(wrongPick)).toEqual([
      STYLESHEET_FALLBACK_MATCHED_NOTHING_WARNING("share/ShareDialog.scss", 214),
    ]);
  });

  it("states that no import chain corroborates the pick and that it matched nothing", () => {
    const [line] = stylesheetMatchWarnings(wrongPick);
    expect(line).toContain("no import chain");
    expect(line).toContain("214");
  });

  it("names --css as the way to say which sheet the component loads", () => {
    expect(stylesheetMatchWarnings(wrongPick)[0]).toContain("--css");
  });

  it("does not advise --wrap, which cannot fix a wrong pick", () => {
    expect(stylesheetMatchWarnings(wrongPick)[0]).not.toContain("--wrap");
  });
});

describe("one stylesheet that matched nothing next to one that did", () => {
  const lines = stylesheetMatchWarnings({
    layer: "entry-chain",
    details: [sheet("src/index.css", 40, 12), sheet("styles/monaco.css", 10, 0)],
  });

  it("reads as one sheet, not as a count with a plural", () => {
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("1 injected stylesheet (styles/monaco.css)");
    expect(lines[0]).not.toContain("injected stylesheets");
    expect(lines[0]).toContain("It carries styling this component does not use");
  });

  it("still gives no --wrap advice", () => {
    expect(lines[0]).not.toContain("--wrap");
  });
});

describe("stylesheets that all matched something", () => {
  it("produces no line at all", () => {
    expect(
      stylesheetMatchWarnings({
        layer: "entry-chain",
        details: [sheet("src/index.css", 40, 12), sheet("src/theme.css", 10, 3)],
      }),
    ).toEqual([]);
  });

  it("produces no line for a fallback pick that did match", () => {
    expect(
      stylesheetMatchWarnings({
        layer: "largest-fallback",
        details: [sheet("src/theme/tokens.css", 40, 12)],
      }),
    ).toEqual([]);
  });

  it("stays silent when no sheet was probed at all", () => {
    expect(stylesheetMatchWarnings({ layer: "none", details: [] })).toEqual([]);
  });

  it("stays silent about a sheet the probe never reported on", () => {
    expect(
      stylesheetMatchWarnings({
        layer: "entry-chain",
        details: [{ file: "src/index.css", bytes: 100, rules: 40 }],
      }),
    ).toEqual([]);
  });
});

describe("an entry stylesheet that matched nothing while nothing else matched either", () => {
  it("keeps the --wrap reading, because the render was measured unstyled", () => {
    const [line] = stylesheetMatchWarnings({
      layer: "entry-chain",
      details: [sheet("css/styles.scss", 1183, 0)],
    });
    expect(line).toBe(STYLESHEET_MATCHED_NOTHING_WARNING("css/styles.scss", 1183));
    expect(line).toContain("--wrap");
  });

  it("collapses several of them into one line that still names the ancestor reading", () => {
    const lines = stylesheetMatchWarnings({
      layer: "entry-chain",
      details: [sheet("a.css", 10, 0), sheet("b.css", 20, 0), sheet("c.css", 30, 0), sheet("d.css", 40, 0)],
    });
    expect(lines).toEqual([
      STYLESHEET_MATCHED_NOTHING_COLLAPSED_WARNING(["a.css", "b.css", "c.css"], 4, {
        othersMatched: false,
      }),
    ]);
    expect(lines[0]).toContain("--wrap");
  });
});
