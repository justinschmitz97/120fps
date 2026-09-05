import { describe, it, expect } from "vitest";
import { formatStylesheetsLine, type CssReport } from "../../src/report/index.js";

// fluentui-F3: a recognised engine must not read like an unrecognised one in this line.
const css = (extra: Partial<CssReport>): CssReport => ({ files: [], ...extra }) as CssReport;

describe("the Stylesheets line for styling generated at runtime", () => {
  it("states a recognised engine as the reason no stylesheet was needed", () => {
    expect(
      formatStylesheetsLine(
        css({
          layer: "runtime",
          runtimeEngines: ["@griffel/react"],
          runtimeEnginesRecognised: true,
        }),
      ),
    ).toBe(
      "Stylesheets: none — styling is generated at runtime by @griffel/react; no stylesheet was " +
        "needed",
    );
  });

  it("marks an unlisted engine as unrecognised and names --css", () => {
    expect(
      formatStylesheetsLine(
        css({
          layer: "runtime",
          runtimeEngines: ["@acme/stylist"],
          runtimeEnginesRecognised: false,
        }),
      ),
    ).toBe(
      "Stylesheets: none — styling appears to be generated at runtime by @acme/stylist " +
        "(unrecognised engine); pass --css if a stylesheet is needed",
    );
  });

  it("reads as recognised when the producer named no confidence", () => {
    expect(
      formatStylesheetsLine(css({ layer: "runtime", runtimeEngines: ["@emotion/react"] })),
    ).toContain("styling is generated at runtime by @emotion/react");
  });
});
