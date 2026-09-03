import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  RUNTIME_STYLE_ENGINES,
  detectRuntimeStyleEngines,
  discoverGlobalCss,
} from "../../src/harness.js";
import { formatStylesheetsLine } from "../../src/report.js";

const GRIFFEL_PROJECT = path.resolve("fixtures/griffel-project");
const UNLISTED_PROJECT = path.resolve("fixtures/unlisted-style-engine");

describe("a package that styles at runtime through a recognised engine", () => {
  it("names Griffel among the engines the recogniser carries", () => {
    expect(RUNTIME_STYLE_ENGINES).toContain("@griffel/react");
    expect(RUNTIME_STYLE_ENGINES).toContain("@griffel/core");
    expect(RUNTIME_STYLE_ENGINES).toContain("antd-style");
    expect(RUNTIME_STYLE_ENGINES).toContain("css-render");
  });

  it("detects the engine the measured package declares", () => {
    expect(detectRuntimeStyleEngines(GRIFFEL_PROJECT)).toEqual(["@griffel/react"]);
  });

  it("resolves to the runtime layer instead of reporting no stylesheet", () => {
    const discovered = discoverGlobalCss(GRIFFEL_PROJECT);
    expect(discovered.source).toBe("runtime");
    expect(discovered.runtimeEngines).toEqual(["@griffel/react"]);
    expect(discovered.runtimeEnginesRecognised).toBe(true);
  });

  it("closes the question in the Stylesheets line", () => {
    const discovered = discoverGlobalCss(GRIFFEL_PROJECT);
    expect(
      formatStylesheetsLine({
        files: [],
        autoDetected: false,
        layer: "runtime",
        runtimeEngines: discovered.runtimeEngines!,
        runtimeEnginesRecognised: discovered.runtimeEnginesRecognised!,
      }),
    ).toBe(
      "Stylesheets: none — styling is generated at runtime by @griffel/react; no stylesheet was needed",
    );
  });
});

describe("a measured file that styles at runtime through an unlisted package", () => {
  it("stays at none found when nothing was read about the measured file", () => {
    const discovered = discoverGlobalCss(UNLISTED_PROJECT);
    expect(discovered.source).toBe("none");
    expect(discovered.runtimeEngines).toBeUndefined();
  });

  it("names the package the makeStyles import came from", () => {
    const discovered = discoverGlobalCss(UNLISTED_PROJECT, undefined, {
      measuredFile: path.join(UNLISTED_PROJECT, "src/Widget.tsx"),
    });
    expect(discovered.source).toBe("runtime");
    expect(discovered.runtimeEngines).toEqual(["@acme/styling"]);
    expect(discovered.runtimeEnginesRecognised).toBe(false);
  });

  it("reads differently from a recognised engine in the Stylesheets line", () => {
    const discovered = discoverGlobalCss(UNLISTED_PROJECT, undefined, {
      measuredFile: path.join(UNLISTED_PROJECT, "src/Widget.tsx"),
    });
    expect(
      formatStylesheetsLine({
        files: [],
        autoDetected: false,
        layer: "runtime",
        runtimeEngines: discovered.runtimeEngines!,
        runtimeEnginesRecognised: discovered.runtimeEnginesRecognised!,
      }),
    ).toBe(
      "Stylesheets: none — styling appears to be generated at runtime by @acme/styling " +
        "(unrecognised engine); pass --css if a stylesheet is needed",
    );
  });

  it("stays quiet for a measured file that imports no styling binding", () => {
    const discovered = discoverGlobalCss(UNLISTED_PROJECT, undefined, {
      measuredFile: path.join(UNLISTED_PROJECT, "package.json"),
    });
    expect(discovered.source).toBe("none");
  });
});
