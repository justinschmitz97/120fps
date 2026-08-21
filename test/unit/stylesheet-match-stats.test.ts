import { describe, it, expect } from "vitest";
import {
  STYLESHEET_MATCH_STATS_SOURCE,
  stylesheetMatchStatsBlock,
  generateEntry,
} from "../../src/harness.js";

type Stats = Array<{ file: string; rules: number; matched: number }>;

interface FakeRule {
  selectorText?: string;
  cssRules?: FakeRule[];
}

function loadCounter(): (specifiers: string[], doc: unknown, root: unknown) => Stats {
  // The same source string the generated entry carries, exercised directly:
  // the page's own copy runs against a real CSSOM, this one against a fake.
  return new Function(
    `${STYLESHEET_MATCH_STATS_SOURCE}\nreturn __120fpsStylesheetMatchStats;`,
  )() as (specifiers: string[], doc: unknown, root: unknown) => Stats;
}

function sheet(devId: string, rules: FakeRule[], throwsOnRules = false): unknown {
  return {
    ownerNode: { getAttribute: (name: string) => (name === "data-vite-dev-id" ? devId : null) },
    get cssRules(): FakeRule[] {
      if (throwsOnRules) throw new Error("cross-origin");
      return rules;
    },
  };
}

function root(matching: string[]): unknown {
  return {
    querySelector: (selector: string) => (matching.includes(selector) ? {} : null),
  };
}

// excalidraw: every rule in the injected stylesheet is nested under
// `.excalidraw`, an ancestor class the harness never renders, so the run
// measured an entirely unstyled button and printed PASS.
describe("counting how many injected rules reach the rendered tree", () => {
  it("counts every rule and the ones that match under the root", () => {
    const stats = loadCounter()(
      ["/css/styles.css"],
      { styleSheets: [sheet("C:/repo/css/styles.css", [{ selectorText: ".a" }, { selectorText: ".b" }])] },
      root([".a"]),
    );
    expect(stats).toEqual([{ file: "css/styles.css", rules: 2, matched: 1 }]);
  });

  it("reports zero matches for rules that need an ancestor class nothing renders", () => {
    const stats = loadCounter()(
      ["/css/styles.css"],
      {
        styleSheets: [
          sheet("C:/repo/css/styles.css", [
            { selectorText: ".excalidraw .ExcButton" },
            { selectorText: ".excalidraw .Dialog" },
          ]),
        ],
      },
      root([".ExcButton"]),
    );
    expect(stats).toEqual([{ file: "css/styles.css", rules: 2, matched: 0 }]);
  });

  it("descends into grouping rules", () => {
    const stats = loadCounter()(
      ["/src/style.css"],
      {
        styleSheets: [
          sheet("C:/repo/src/style.css", [
            { selectorText: ".outer" },
            { cssRules: [{ selectorText: ".inner" }, { cssRules: [{ selectorText: ".deep" }] }] },
          ]),
        ],
      },
      root([".inner", ".deep"]),
    );
    expect(stats).toEqual([{ file: "src/style.css", rules: 3, matched: 2 }]);
  });

  it("skips a stylesheet whose rules cannot be read", () => {
    const stats = loadCounter()(
      ["/src/style.css"],
      { styleSheets: [sheet("C:/repo/src/style.css", [{ selectorText: ".a" }], true)] },
      root([".a"]),
    );
    expect(stats).toEqual([{ file: "src/style.css", rules: 0, matched: 0 }]);
  });

  it("counts a selector querySelector rejects as unmatched instead of throwing", () => {
    const stats = loadCounter()(
      ["/src/style.css"],
      { styleSheets: [sheet("C:/repo/src/style.css", [{ selectorText: "@@bad" }])] },
      {
        querySelector: () => {
          throw new Error("invalid selector");
        },
      },
    );
    expect(stats).toEqual([{ file: "src/style.css", rules: 1, matched: 0 }]);
  });

  it("counts a document-scoped rule as applying", () => {
    const stats = loadCounter()(
      ["/src/tokens.css"],
      {
        styleSheets: [
          sheet("C:/repo/src/tokens.css", [
            { selectorText: ":root" },
            { selectorText: "html, body" },
            { selectorText: "*" },
          ]),
        ],
      },
      root([]),
    );
    expect(stats).toEqual([{ file: "src/tokens.css", rules: 3, matched: 3 }]);
  });

  it("counts a rule matching the mount root itself", () => {
    const stats = loadCounter()(
      ["/src/style.css"],
      { styleSheets: [sheet("C:/repo/src/style.css", [{ selectorText: "#root" }])] },
      { querySelector: () => null, matches: (selector: string) => selector === "#root" },
    );
    expect(stats).toEqual([{ file: "src/style.css", rules: 1, matched: 1 }]);
  });

  it("counts a grouped selector when any one part matches under the root", () => {
    const stats = loadCounter()(
      ["/src/style.css"],
      {
        styleSheets: [
          sheet("C:/repo/src/style.css", [
            { selectorText: ".absent, .present" },
            { selectorText: ".excalidraw .a, .excalidraw .b" },
          ]),
        ],
      },
      root([".present"]),
    );
    expect(stats).toEqual([{ file: "src/style.css", rules: 2, matched: 1 }]);
  });

  it("ignores stylesheets that are not the injected ones", () => {
    const stats = loadCounter()(
      ["/src/style.css"],
      {
        styleSheets: [
          sheet("C:/repo/src/other.css", [{ selectorText: ".a" }]),
          sheet("C:/repo/src/style.css", [{ selectorText: ".b" }]),
        ],
      },
      root([".a", ".b"]),
    );
    expect(stats).toEqual([{ file: "src/style.css", rules: 1, matched: 1 }]);
  });

  it("keys an out-of-root stylesheet by its own absolute path", () => {
    const stats = loadCounter()(
      ["/@fs/C:/other/pkg/index.css"],
      { styleSheets: [sheet("C:/other/pkg/index.css", [{ selectorText: ".a" }])] },
      root([".a"]),
    );
    expect(stats).toEqual([{ file: "C:/other/pkg/index.css", rules: 1, matched: 1 }]);
  });

  it("reports a sheet that was never injected as zero of zero", () => {
    const stats = loadCounter()(["/src/style.css"], { styleSheets: [] }, root([]));
    expect(stats).toEqual([{ file: "src/style.css", rules: 0, matched: 0 }]);
  });
});

describe("the page API a run reads the match counts through", () => {
  it("is absent when no stylesheet was injected", () => {
    expect(stylesheetMatchStatsBlock([])).toBe("");
    expect(stylesheetMatchStatsBlock(undefined)).toBe("");
  });

  it("is exposed on window.__120fps for every injected stylesheet", () => {
    const block = stylesheetMatchStatsBlock(["/src/style.css", "/@fs/C:/pkg/index.css"]);
    expect(block).toContain("stylesheetMatchStats");
    expect(block).toContain('"/src/style.css"');
    expect(block).toContain('"/@fs/C:/pkg/index.css"');
  });

  it("reaches the generated React and Vue entries", () => {
    const options = {
      componentRelative: "src/Widget.tsx",
      componentName: "Widget",
      isDefaultExport: true,
      hasScale: false,
      cssImports: ["/src/style.css"],
    };
    expect(generateEntry(options)).toContain("stylesheetMatchStats");
    expect(generateEntry({ ...options, renderer: "vue" as const })).toContain("stylesheetMatchStats");
  });
});
