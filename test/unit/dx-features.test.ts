import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  parseArgs,
  splitTargetSpec,
  formatWallClock,
  helpText,
} from "../../src/cli.js";
import {
  explainProps,
  formatExplainProps,
  resolveProgressReporter,
} from "../../src/analyze.js";
import {
  runPreflight,
  detectProviderImport,
  providerCandidateLabels,
} from "../../src/preflight.js";
import { detectComponentExport } from "../../src/harness.js";
import { extractPropsDetailed } from "../../src/prop-gen.js";
import { formatHints } from "../../src/hints.js";
import type { Report } from "../../src/report.js";

const fixture = (rel: string): string => path.resolve("fixtures", rel);

function lineOf(file: string, needle: string): number {
  const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
  const index = lines.findIndex((l) => l.includes(needle));
  return index + 1;
}

// --- C5: `<file>#Export` splitting, decided without the filesystem ---

describe("target spec splitting", () => {
  it("splits a component path from its export name", () => {
    expect(splitTargetSpec("./fixtures/two-exports.tsx#SecondaryBtn")).toEqual({
      path: "./fixtures/two-exports.tsx",
      target: "SecondaryBtn",
    });
  });

  it("leaves a Windows path with a # directory segment whole", () => {
    const p = "C:\\Projekte\\c#1\\Button.tsx";
    expect(splitTargetSpec(p)).toEqual({ path: p });
  });

  it("leaves a Windows path whose filename contains # whole", () => {
    const p = "C:\\Projekte\\120fps\\Button#2.tsx";
    expect(splitTargetSpec(p)).toEqual({ path: p });
  });

  it("splits a Windows absolute path from its export name", () => {
    expect(splitTargetSpec("C:\\Projekte\\120fps\\fixtures\\two-exports.tsx#SecondaryBtn")).toEqual({
      path: "C:\\Projekte\\120fps\\fixtures\\two-exports.tsx",
      target: "SecondaryBtn",
    });
  });

  it("does not split when the left side is not a component file", () => {
    expect(splitTargetSpec("./notes.md#Heading")).toEqual({ path: "./notes.md#Heading" });
  });

  it("does not split on a non-identifier fragment", () => {
    expect(splitTargetSpec("./a.tsx#not-an-identifier")).toEqual({
      path: "./a.tsx#not-an-identifier",
    });
  });

  it("parseArgs records the target keyed by the path it typed", () => {
    const args = parseArgs(["./fixtures/two-exports.tsx#SecondaryBtn"]);
    expect(args.error).toBeUndefined();
    expect(args.componentPath).toBe("./fixtures/two-exports.tsx");
    expect(args.targets).toEqual({ "./fixtures/two-exports.tsx": "SecondaryBtn" });
  });

  it("parseArgs rejects --fixture combined with an export target", () => {
    const args = parseArgs([
      "./fixtures/two-exports.tsx#SecondaryBtn",
      "--fixture",
      "./fixtures/standalone.fixture.tsx",
    ]);
    expect(args.error).toMatch(/#/);
  });
});

describe("explicit export resolution", () => {
  it("resolves the named export over the default selection order", () => {
    expect(detectComponentExport(fixture("two-exports.tsx")).name).toBe("PrimaryBtn");
    expect(detectComponentExport(fixture("two-exports.tsx"), "SecondaryBtn")).toEqual({
      name: "SecondaryBtn",
      isDefaultOnly: false,
    });
  });

  it("throws a message listing the file's component exports", () => {
    expect(() => detectComponentExport(fixture("two-exports.tsx"), "Nope")).toThrow(
      /Nope/,
    );
    let message = "";
    try {
      detectComponentExport(fixture("two-exports.tsx"), "Nope");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("PrimaryBtn");
    expect(message).toContain("SecondaryBtn");
  });

  it("binds prop extraction to the named export", async () => {
    const detail = await extractPropsDetailed(fixture("two-exports.tsx"), {
      target: "SecondaryBtn",
    });
    expect(detail.targetName).toBe("SecondaryBtn");
    expect(detail.schemas.map((s) => s.name).sort()).toEqual(["outlined", "text"]);
  });
});

// --- C6: one stem rule ---

describe("the harness resolver uses the normalized stem", () => {
  it("resolves hotspot-image.tsx to HotspotImage", () => {
    expect(detectComponentExport(fixture("m58/hotspot-image.tsx")).name).toBe("HotspotImage");
  });

  it("resolves alias-widget.tsx to the exported alias", () => {
    expect(detectComponentExport(fixture("m58/alias-widget.tsx")).name).toBe("AliasWidget");
  });
});

// --- C1: --explain-props ---

describe("--explain-props", () => {
  it("is a known flag and appears in --help", () => {
    const args = parseArgs(["./fixtures/button.tsx", "--explain-props"]);
    expect(args.error).toBeUndefined();
    expect(args.explainProps).toBe(true);
    expect(helpText()).toContain("--explain-props");
    expect(helpText()).toContain("#ExportName");
  });

  it("names the resolved component and the declaration it bound to", async () => {
    const file = fixture("m58/hotspot-image.tsx");
    const explained = await explainProps(file);
    expect(explained.componentName).toBe("HotspotImage");
    expect(explained.bindingLine).toBe(lineOf(file, "export function HotspotImage"));
    expect(explained.bindingFile).toMatch(/hotspot-image\.tsx$/);
    expect(explained.exports).toEqual(["Marker", "HotspotImage"]);
    expect(explained.props.map((p) => p.name).sort()).toEqual(["hotspots", "src", "zoom"]);
  });

  it("reports the prop that would drive curve mode", async () => {
    const explained = await explainProps(fixture("m58/hotspot-image.tsx"));
    expect(explained.curve?.propName).toBe("hotspots");
    const text = formatExplainProps(explained);
    expect(text).toContain("Curve mode:");
    expect(text).toContain("hotspots");
  });

  it("enumerates cva unions and reports matrix auto-activation", async () => {
    const explained = await explainProps(fixture("m60/cva-button.tsx"));
    const variant = explained.props.find((p) => p.name === "variant");
    expect(variant?.kind).toBe("union");
    expect(variant?.values).toEqual(
      expect.arrayContaining(["default", "destructive", "outline"]),
    );
    expect(explained.matrixWouldActivate).toBe(true);
    expect(formatExplainProps(explained)).toContain("Matrix mode:");
  });

  it("marks degenerate props with a reason", async () => {
    const explained = await explainProps(fixture("m60/unsynthesizable.tsx"));
    const store = explained.props.find((p) => p.name === "store");
    expect(store?.degenerate).toBeTruthy();
    const text = formatExplainProps(explained);
    expect(text).toContain("degenerate");
    expect(explained.warnings.join("\n")).toMatch(/no representative value/i);
  });

  it("explains a named export target", async () => {
    const explained = await explainProps(fixture("two-exports.tsx"), {
      target: "SecondaryBtn",
    });
    expect(explained.componentName).toBe("SecondaryBtn");
    expect(explained.props.map((p) => p.name).sort()).toEqual(["outlined", "text"]);
  });

  it("explains a Vue SFC", async () => {
    const explained = await explainProps(fixture("vue-project/Button.vue"));
    expect(explained.componentName).toBe("Button");
    expect(explained.props.map((p) => p.name).sort()).toEqual([
      "count",
      "disabled",
      "label",
      "variant",
    ]);
    expect(formatExplainProps(explained)).toContain("Button");
  });
});

// --- C2: progress heartbeat ---

describe("progress heartbeat", () => {
  it("writes one line per marker outside CI mode", () => {
    const written: string[] = [];
    const report = resolveProgressReporter({}, (s) => written.push(s));
    report("mount: 8 combos");
    report("rerender: 8 combos");
    expect(written).toEqual(["mount: 8 combos\n", "rerender: 8 combos\n"]);
  });

  it("emits nothing in --ci mode", () => {
    const written: string[] = [];
    const report = resolveProgressReporter({ ci: true }, (s) => written.push(s));
    report("mount: 8 combos");
    expect(written).toEqual([]);
  });

  it("routes to a caller-supplied sink instead of stdout", () => {
    const seen: string[] = [];
    const written: string[] = [];
    const report = resolveProgressReporter(
      { onProgress: (l) => seen.push(l) },
      (s) => written.push(s),
    );
    report("explore: 6 combos");
    expect(seen).toEqual(["explore: 6 combos"]);
    expect(written).toEqual([]);
  });

  it("suppresses a caller-supplied sink in CI mode too", () => {
    const seen: string[] = [];
    const report = resolveProgressReporter({ ci: true, onProgress: (l) => seen.push(l) });
    report("mount: 1 combo");
    expect(seen).toEqual([]);
  });
});

// --- C3: total wall clock ---

describe("total wall clock", () => {
  it("formats sub-minute runs in seconds", () => {
    expect(formatWallClock(42_100)).toBe("Total: 42.1s");
    expect(formatWallClock(1_500)).toBe("Total: 1.5s");
    expect(formatWallClock(0)).toBe("Total: 0.0s");
  });

  it("formats longer runs as minutes and seconds", () => {
    expect(formatWallClock(252_000)).toBe("Total: 4m 12s");
    expect(formatWallClock(60_000)).toBe("Total: 1m 0s");
    expect(formatWallClock(3_723_000)).toBe("Total: 62m 3s");
  });
});

// --- C4: provider-hook detection ---

describe("provider detection", () => {
  it("recognizes known provider libraries including sub-paths", () => {
    expect(detectProviderImport("next-intl")?.hook).toBe("useTranslations");
    expect(detectProviderImport("next-intl/client")?.source).toBe("next-intl");
    expect(detectProviderImport("react-i18next")?.hook).toBe("useTranslation");
    expect(detectProviderImport("react-redux")?.hook).toBe("useSelector");
    expect(detectProviderImport("@tanstack/react-query")?.hook).toBe("useQuery");
    expect(detectProviderImport("react")).toBeUndefined();
    expect(detectProviderImport("./local")).toBeUndefined();
  });

  // M72: routing/meta-framework libraries whose hooks throw outside their
  // router or route context, the same shape as the four existing entries.
  it("recognizes routing and meta-framework provider libraries", () => {
    expect(detectProviderImport("react-router")?.hook).toBe("useNavigate");
    expect(detectProviderImport("react-router-dom")?.hook).toBe("useNavigate");
    expect(detectProviderImport("react-router-dom/client")?.source).toBe("react-router-dom");
    expect(detectProviderImport("@remix-run/react")?.hook).toBe("useLoaderData");
    expect(detectProviderImport("gatsby")?.hook).toBe("useStaticQuery");
    expect(detectProviderImport("@tanstack/react-router")?.hook).toBe("useRouter");
    expect(detectProviderImport("@tanstack/react-start")?.hook).toBe("useRouter");
  });

  it("records a package provider import from the walked graph", () => {
    const result = runPreflight({
      projectRoot: path.resolve("fixtures"),
      entries: [fixture("m65/intl-widget.tsx")],
    });
    expect(result.providers.map((p) => p.source)).toContain("next-intl");
    expect(providerCandidateLabels(result.providers)).toContain("next-intl (useTranslations)");
  });

  it("records a local context module that throws in its hook", () => {
    const result = runPreflight({
      projectRoot: path.resolve("fixtures"),
      entries: [fixture("m65/workbench-consumer.tsx")],
    });
    const local = result.providers.find((p) => p.local);
    expect(local?.source).toMatch(/workbench-store\.tsx$/);
    expect(local?.hook).toBe("useWorkbench");
  });

  it("does not flag a local context module that never throws", () => {
    const result = runPreflight({
      projectRoot: path.resolve("fixtures"),
      entries: [fixture("m65/healthy-consumer.tsx")],
    });
    expect(result.providers).toEqual([]);
  });

  it("names the candidates in the render-error hint", () => {
    const report = {
      combos: [],
      providerCandidates: ["next-intl (useTranslations)"],
    } as unknown as Report;
    const text = formatHints(["renderError"], report);
    expect(text).toContain("component imports next-intl (useTranslations)");
    expect(text).toContain("--wrap");
    expect(text).toContain("120fps.setup.tsx");
  });

  it("prints the plain render-error hint when nothing was detected", () => {
    const text = formatHints(["renderError"]);
    expect(text).toContain("threw instead of rendering");
    expect(text).not.toContain("component imports");
  });
});
