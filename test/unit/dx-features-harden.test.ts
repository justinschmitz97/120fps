import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseArgs, splitTargetSpec, formatWallClock, expandComponentPaths, nodePathReader } from "../../src/cli.js";
import {
  explainProps,
  formatExplainProps,
  resolveProgressReporter,
  renderFailed,
  analyze,
  TARGET_WITH_FIXTURE_ERROR,
  ZERO_PROPS_WARNING,
} from "../../src/analyze.js";
import { runPreflight, providerCandidateLabels } from "../../src/preflight.js";
import { detectComponentExport } from "../../src/harness.js";
import { extractPropsDetailed } from "../../src/prop-gen.js";
import { formatHints } from "../../src/hints.js";
import type { Report } from "../../src/report.js";

const fixture = (rel: string): string => path.resolve("fixtures", rel);
const FIXTURE_ROOT = path.resolve("fixtures");

// H1: a file whose own name contains `#` is a path, never a target spec.
describe("H1: a real filename containing #", () => {
  it("is left whole by the splitter and still resolves on disk", () => {
    const typed = "./fixtures/m65/hash#name.tsx";
    expect(splitTargetSpec(typed)).toEqual({ path: typed });
    const expanded = expandComponentPaths([typed], nodePathReader());
    expect(expanded.error).toBeUndefined();
    expect(expanded.paths).toEqual([typed]);
    expect(fs.existsSync(path.resolve(typed))).toBe(true);
  });

  it("still accepts an export target appended to it", () => {
    expect(splitTargetSpec("./fixtures/m65/hash#name.tsx#HashName")).toEqual({
      path: "./fixtures/m65/hash#name.tsx",
      target: "HashName",
    });
  });
});

// H2: a second `#` in the argument does not produce a nested split.
describe("H2: two hashes", () => {
  it("does not split when the left side stops being a component path", () => {
    expect(splitTargetSpec("./a.tsx#B#C")).toEqual({ path: "./a.tsx#B#C" });
  });

  it("splits only the trailing identifier when the left side is still a path", () => {
    expect(splitTargetSpec("./dir#1/a.tsx#B")).toEqual({ path: "./dir#1/a.tsx", target: "B" });
  });
});

// H3: a file with no component export.
describe("H3: --explain-props on a file with no component", () => {
  it("falls back to the filename and reports an empty export list", async () => {
    const explained = await explainProps(fixture("m65/no-component.tsx"));
    expect(explained.exports).toEqual([]);
    expect(explained.props).toEqual([]);
    expect(explained.warnings).toContain(ZERO_PROPS_WARNING);
    const text = formatExplainProps(explained);
    expect(text).toContain("exports:  (none)");
    expect(text).toContain("(none extracted)");
    expect(text).toContain("Dry run: nothing was measured");
  });
});

// H4: presets replace the pool the run would measure.
describe("H4: --explain-props with a <stem>.props.tsx preset", () => {
  it("shows the preset values and names the preset file", async () => {
    const explained = await explainProps(fixture("m44-preset-card.tsx"));
    expect(explained.presetPath).toBeTruthy();
    const title = explained.props.find((p) => p.name === "title");
    expect(title?.values).toEqual(["Quarterly revenue", "Q"]);
    const text = formatExplainProps(explained);
    expect(text).toContain("presets:");
    expect(text).toContain("Quarterly revenue");
    // The preset names a key the component does not declare: same warning the
    // measured run would push.
    expect(explained.warnings.join("\n")).toContain("notAProp");
  });
});

// H5: explain is a dry run whatever else was typed.
describe("H5: --explain-props alongside mode flags", () => {
  it("parses cleanly with --json, --ci, --curve and --matrix", () => {
    const args = parseArgs([
      "./fixtures/button.tsx",
      "--explain-props",
      "--json",
      "out.json",
      "--ci",
      "--matrix",
    ]);
    expect(args.error).toBeUndefined();
    expect(args.explainProps).toBe(true);
    expect(args.ci).toBe(true);
  });

  it("still rejects the flag combinations that were already errors", () => {
    const args = parseArgs(["./fixtures/button.tsx", "--explain-props", "--curve", "--matrix"]);
    expect(args.error).toContain("--curve cannot be combined with --matrix");
  });
});

// H6: the marker format is a plain line, whatever the phase.
describe("H6: heartbeat line shape", () => {
  it("writes exactly one newline-terminated line with no control characters", () => {
    const written: string[] = [];
    const report = resolveProgressReporter({}, (s) => written.push(s));
    for (const line of ["mount: 8 combos x 10 samples", "explore: 6 combos, budget 10s each"]) {
      report(line);
    }
    expect(written.every((s) => s.endsWith("\n"))).toBe(true);
    expect(written.every((s) => s.split("\n").length === 2)).toBe(true);
    // No ANSI, no carriage returns, nothing that redraws a line.
    const printable = (line: string): boolean =>
      [...line.slice(0, -1)].every((ch) => ch.charCodeAt(0) >= 32);
    expect(written.every(printable)).toBe(true);
  });

  it("keeps a shared sink usable across the components of a sweep", () => {
    const seen: string[] = [];
    const sink = (line: string): void => void seen.push(line);
    resolveProgressReporter({ onProgress: sink })("mount: 2 combos");
    resolveProgressReporter({ onProgress: sink })("mount: 3 combos");
    expect(seen).toEqual(["mount: 2 combos", "mount: 3 combos"]);
  });
});

// H7: static detection alone never nags.
describe("H7: provider candidates on a healthy run", () => {
  it("renderFailed is false for a report with no render error", () => {
    const healthy = {
      combos: [{ renderHealth: undefined }, {}],
      warnings: ["measured 8 of 12 combos"],
    } as unknown as Report;
    expect(renderFailed(healthy)).toBe(false);
  });

  it("renderFailed is true for a gated combo and for a curve scale point", () => {
    expect(renderFailed({ combos: [{ renderHealth: "error" }] } as unknown as Report)).toBe(true);
    expect(
      renderFailed({
        combos: [],
        warnings: ["scale point N=20 rendered 0 DOM nodes while the page threw"],
      } as unknown as Report),
    ).toBe(true);
  });

  it("a local context module that never throws is not a candidate", () => {
    const result = runPreflight({
      projectRoot: FIXTURE_ROOT,
      entries: [fixture("needs-context.tsx")],
    });
    expect(result.providers).toEqual([]);
  });

  it("the hint carries no provider line when the report has no candidates", () => {
    const text = formatHints(["renderError"], { combos: [] } as unknown as Report);
    expect(text).not.toContain("component imports");
  });
});

// H8: a type-only import is erased before it reaches a browser.
describe("H8: type-only provider import", () => {
  it("is not recorded as a provider candidate", () => {
    const result = runPreflight({
      projectRoot: FIXTURE_ROOT,
      entries: [fixture("m65/type-only-intl.tsx")],
    });
    expect(result.providers).toEqual([]);
  });
});

// H9: the same package imported by two files in the graph.
describe("H9: duplicate provider imports", () => {
  it("are recorded and labelled once", () => {
    const result = runPreflight({
      projectRoot: FIXTURE_ROOT,
      entries: [fixture("m65/intl-pair.tsx")],
    });
    expect(result.providers.filter((p) => p.source === "next-intl")).toHaveLength(1);
    expect(providerCandidateLabels(result.providers)).toEqual(["next-intl (useTranslations)"]);
  });
});

// H10: an alias is the name the module exports under.
describe("H10: #Export naming an export alias", () => {
  it("resolves and binds to the aliased declaration's props", async () => {
    expect(detectComponentExport(fixture("m58/alias-widget.tsx"), "AliasWidget").name).toBe(
      "AliasWidget",
    );
    const detail = await extractPropsDetailed(fixture("m58/alias-widget.tsx"), {
      target: "AliasWidget",
    });
    expect(detail.schemas.map((s) => s.name).sort()).toEqual(["rows", "title"]);
  });

  it("resolves the other export of the same file just as well", async () => {
    const detail = await extractPropsDetailed(fixture("m58/alias-widget.tsx"), {
      target: "Helper",
    });
    expect(detail.schemas.map((s) => s.name).sort()).toEqual(["a", "b"]);
  });
});

// H11: a Vue SFC has exactly one component.
describe("H11: #Export on a Vue SFC", () => {
  it("accepts the SFC's own name and rejects any other", () => {
    expect(detectComponentExport(fixture("vue-project/Button.vue"), "Button").name).toBe("Button");
    expect(() => detectComponentExport(fixture("vue-project/Button.vue"), "Other")).toThrow(
      /Other/,
    );
  });
});

// H12: a fixture already decides what renders.
describe("H12: #Export with a fixture", () => {
  it("is rejected by the programmatic entry point before any harness is built", async () => {
    await expect(
      analyze("./fixtures/two-exports.tsx", {
        target: "SecondaryBtn",
        fixturePath: "./fixtures/standalone.fixture.tsx",
      }),
    ).rejects.toThrow(TARGET_WITH_FIXTURE_ERROR);
  });

  it("rejects an unknown export before any harness is built", async () => {
    await expect(
      analyze("./fixtures/two-exports.tsx", { target: "Nope" }),
    ).rejects.toThrow(/PrimaryBtn/);
  });
});

// H13: the binding line points at the component, not at an earlier helper.
describe("H13: explain on a file with a hijacking helper", () => {
  it("names the target and its own declaration line", async () => {
    const file = fixture("m58/colorpicker.tsx");
    const source = fs.readFileSync(file, "utf-8").split(/\r?\n/);
    const explained = await explainProps(file);
    expect(explained.componentName).toBe("ColorPicker");
    expect(explained.bindingLine).toBeGreaterThan(0);
    expect(source[explained.bindingLine! - 1]).toContain("ColorPicker");
  });
});

// H14: wall-clock boundaries.
describe("H14: wall-clock formatting boundaries", () => {
  it("switches unit exactly at one minute", () => {
    expect(formatWallClock(59_940)).toBe("Total: 59.9s");
    expect(formatWallClock(60_000)).toBe("Total: 1m 0s");
    expect(formatWallClock(60_499)).toBe("Total: 1m 0s");
    expect(formatWallClock(89_000)).toBe("Total: 1m 29s");
  });
});

// H15: a wide value pool is a sample, not a dump.
describe("H15: explain truncates long value pools", () => {
  it("shows the first values and counts the rest", async () => {
    const explained = await explainProps(fixture("large-union.tsx"));
    const country = explained.props.find((p) => p.name === "country");
    expect(country?.values.length).toBeGreaterThan(4);
    const text = formatExplainProps(explained);
    expect(text).toMatch(/\+\d+ more/);
    expect(text.split("\n").every((l) => l.length < 200)).toBe(true);
  });
});

// H16: the untargeted resolution order is unchanged.
describe("H16: no behavior change without a target", () => {
  it("keeps the exact-stem and default-export rules", () => {
    expect(detectComponentExport(fixture("button.tsx")).name).toBe("Button");
    expect(detectComponentExport(fixture("default-only.tsx")).isDefaultOnly).toBe(true);
    expect(detectComponentExport(fixture("two-exports.tsx")).name).toBe("PrimaryBtn");
  });

  it("leaves an argument with no hash untouched", () => {
    const args = parseArgs(["./fixtures/button.tsx", "--samples", "3"]);
    expect(args.targets).toBeUndefined();
    expect(args.componentPath).toBe("./fixtures/button.tsx");
  });
});

// H17: extraction warnings stay on stderr for a measured run.
describe("H17: the warning sink does not leak into normal extraction", () => {
  it("collects into the result only when a sink was supplied", async () => {
    const withSink = await extractPropsDetailed(fixture("m60/unsynthesizable.tsx"), {
      onWarning: () => {},
    });
    expect(withSink.warnings.length).toBeGreaterThan(0);
    const withoutSink = await extractPropsDetailed(fixture("m60/unsynthesizable.tsx"));
    expect(withoutSink.warnings).toEqual([]);
    expect(withoutSink.schemas.map((s) => s.name)).toEqual(withSink.schemas.map((s) => s.name));
  });
});

// H18: explaining two components in one invocation.
describe("H18: explaining several components", () => {
  it("produces an independent explanation per file", async () => {
    const a = await explainProps(fixture("two-exports.tsx"));
    const b = await explainProps(fixture("m58/hotspot-image.tsx"));
    expect(a.componentName).toBe("PrimaryBtn");
    expect(b.componentName).toBe("HotspotImage");
    expect(formatExplainProps(a)).not.toBe(formatExplainProps(b));
  });
});

// H19: a missing file is a setup error, not a crash.
describe("H19: explain on a missing file", () => {
  it("throws the same message the pipeline uses", async () => {
    await expect(explainProps("./fixtures/definitely-not-here.tsx")).rejects.toThrow(
      /Component file not found/,
    );
  });
});

// M83 #5 (base-ui-F6): --explain-props' "Curve mode: would (not) activate"
// line only predicts detectScalingProps's whole-run auto-activation. The M61
// sibling-copies scale probe is a separate, unconditional mechanism that
// still runs on a non-fixture target whenever curve mode does not.
describe("M83 #5: scaleProbeWillRun predicts the sibling-copies scale probe", () => {
  it("is false when curve mode would activate (the scale probe never runs then)", async () => {
    const explained = await explainProps(fixture("m58/hotspot-image.tsx"));
    expect(explained.curve?.propName).toBe("hotspots");
    expect(explained.scaleProbeWillRun).toBe(false);
    expect(formatExplainProps(explained)).not.toContain("Scale probe:");
  });

  it("is true for a non-fixture target with no array/numeric prop", async () => {
    const explained = await explainProps(fixture("m60/cva-button.tsx"));
    expect(explained.curve).toBeUndefined();
    expect(explained.scaleProbeWillRun).toBe(true);
    const text = formatExplainProps(explained);
    expect(text).toContain("Scale probe:");
    expect(text).toContain("N=1/5/20/50");
    expect(text).toContain("independent of curve mode");
  });

  it("is false for a .fixture.tsx target even with no curve match", async () => {
    const explained = await explainProps(fixture("broken.fixture.tsx"));
    expect(explained.curve).toBeUndefined();
    expect(explained.scaleProbeWillRun).toBe(false);
    expect(formatExplainProps(explained)).not.toContain("Scale probe:");
  });
});

// M83 #8 (chakra-ui-F7): detectComponentExport picking the file's own marked
// `export default` is correct by JS/TS semantics — this does not change
// which export is picked, only discloses the #ExportName escape hatch when
// the resolved export has a degenerate required prop and a sibling export
// does not.
describe("M83 #8: alternative-export disclosure for a degenerate required prop", () => {
  it("names the sibling export and its #ExportName override", async () => {
    const explained = await explainProps(fixture("m83/alt-export.tsx"));
    expect(explained.componentName).toBe("AltExportDefault");
    expect(explained.warnings.join("\n")).toContain("AltExportNamed");
    expect(explained.warnings.join("\n")).toContain("#AltExportNamed");
  });

  it("says nothing when the target was already explicitly chosen (the escape hatch already used)", async () => {
    const explained = await explainProps(fixture("m83/alt-export.tsx"), { target: "AltExportDefault" });
    expect(explained.warnings.join("\n")).not.toContain("AltExportNamed");
  });

  it("says nothing when the resolved export has no degenerate required prop", async () => {
    const explained = await explainProps(fixture("two-exports.tsx"));
    expect(explained.warnings.join("\n")).not.toMatch(/#\w+.*override|Target it with/);
  });
});

// H20: the provider hint reads as one actionable line per candidate.
describe("H20: provider hint text", () => {
  it("names every candidate exactly once", () => {
    // M79 (4a): the provider hint is gated on a captured page-error message
    // that actually looks provider/context-shaped.
    const report = {
      combos: [{ pageErrors: ["Cannot read properties of undefined (reading 'Context')"] }],
      providerCandidates: ["next-intl (useTranslations)", "src/store.tsx (useWorkbench)"],
    } as unknown as Report;
    const text = formatHints(["renderError"], report);
    expect(text.match(/component imports/g)).toHaveLength(2);
    expect(text).toContain("src/store.tsx (useWorkbench)");
  });
});
