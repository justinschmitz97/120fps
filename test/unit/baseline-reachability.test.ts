import { describe, it, expect } from "vitest";
import {
  KNOWN_FLAGS,
  helpText,
  parseArgs,
  resolveCurveOption,
  resolveMatrixOption,
} from "../../src/cli.js";
import {
  MATRIX_BASELINE_WARNING,
  baselineWorkflowRequested,
  optionsAllowVerdictReuse,
} from "../../src/analyze.js";

// D1: a matrix run returns before applyBaselineWorkflow, so every baseline flag
// on it is a no-op. The run must say so.
describe("D1: matrix mode discloses that baselines do not apply", () => {
  it("--save-baseline on a matrix run counts as a baseline request", () => {
    expect(baselineWorkflowRequested({ saveBaseline: true })).toBe(true);
  });

  it("--check on a matrix run counts as a baseline request", () => {
    expect(baselineWorkflowRequested({ check: true })).toBe(true);
  });

  it("--budget reaches the same request through --check", () => {
    const args = parseArgs(["./Button.tsx", "--budget"]);
    expect(args.check).toBe(true);
    expect(args.ci).toBe(true);
    expect(baselineWorkflowRequested({ check: args.check })).toBe(true);
  });

  it("--check --no-baseline asked for no comparison, so nothing is withheld", () => {
    expect(baselineWorkflowRequested({ check: true, noBaseline: true })).toBe(false);
  });

  it("--save-baseline survives --no-baseline: that flag only suppresses the check", () => {
    expect(baselineWorkflowRequested({ saveBaseline: true, noBaseline: true })).toBe(true);
  });

  it("a run with no baseline flag gets no warning", () => {
    expect(baselineWorkflowRequested({})).toBe(false);
  });

  it("the warning names the limitation and the workaround", () => {
    expect(MATRIX_BASELINE_WARNING).toContain("matrix");
    expect(MATRIX_BASELINE_WARNING).toContain("baseline");
    expect(MATRIX_BASELINE_WARNING).toContain("--no-matrix");
  });
});

// D2: mode-disable flags are fully described by the mode the fingerprint
// records, so they must not disqualify reuse the way mode-enable flags do.
describe("D2: verdict reuse gate", () => {
  it("plain --check is eligible", () => {
    expect(optionsAllowVerdictReuse({ check: true })).toBe(true);
  });

  it("--no-matrix --check is eligible", () => {
    expect(optionsAllowVerdictReuse({ check: true, matrixMode: false })).toBe(true);
  });

  it("--no-curve --check is eligible", () => {
    expect(optionsAllowVerdictReuse({ check: true, curveMode: false })).toBe(true);
  });

  it("--no-matrix --no-curve --check is eligible", () => {
    expect(
      optionsAllowVerdictReuse({ check: true, matrixMode: false, curveMode: false }),
    ).toBe(true);
  });

  it("--matrix always measures", () => {
    expect(optionsAllowVerdictReuse({ check: true, matrixMode: true })).toBe(false);
  });

  it("--curve always measures", () => {
    expect(optionsAllowVerdictReuse({ check: true, curveMode: true })).toBe(false);
  });

  it("--curve prop:array always measures", () => {
    expect(
      optionsAllowVerdictReuse({
        check: true,
        curveMode: { propName: "items", propKind: "array" },
      }),
    ).toBe(false);
  });

  it("--isolate always measures", () => {
    expect(optionsAllowVerdictReuse({ check: true, isolation: { phases: ["mount"] } })).toBe(
      false,
    );
  });

  it("without --check there is nothing to reuse", () => {
    expect(optionsAllowVerdictReuse({})).toBe(false);
    expect(optionsAllowVerdictReuse({ matrixMode: false })).toBe(false);
  });

  it("--no-cache always measures", () => {
    expect(optionsAllowVerdictReuse({ check: true, noCache: true })).toBe(false);
    expect(optionsAllowVerdictReuse({ check: true, matrixMode: false, noCache: true })).toBe(
      false,
    );
  });

  it("--no-baseline always measures", () => {
    expect(optionsAllowVerdictReuse({ check: true, noBaseline: true })).toBe(false);
  });

  it("--save-baseline always measures", () => {
    expect(optionsAllowVerdictReuse({ check: true, saveBaseline: true })).toBe(false);
    expect(
      optionsAllowVerdictReuse({ check: true, matrixMode: false, saveBaseline: true }),
    ).toBe(false);
  });

  it("only the default normalize env policy is eligible", () => {
    expect(optionsAllowVerdictReuse({ check: true, baselineEnv: "normalize" })).toBe(true);
    expect(optionsAllowVerdictReuse({ check: true, baselineEnv: "strict" })).toBe(false);
    expect(optionsAllowVerdictReuse({ check: true, baselineEnv: "ignore" })).toBe(false);
    expect(
      optionsAllowVerdictReuse({ check: true, matrixMode: false, baselineEnv: "strict" }),
    ).toBe(false);
  });
});

// D3: the flag that controls reuse was invisible to --help's own parity guard,
// because a flag missing from both sides of it passes.
describe("D3: --no-cache is discoverable", () => {
  it("is a known flag", () => {
    expect(KNOWN_FLAGS.has("--no-cache")).toBe(true);
  });

  it("appears in the help text", () => {
    expect(helpText()).toContain("--no-cache");
  });

  it("parses", () => {
    expect(parseArgs(["./Button.tsx", "--no-cache"]).noCache).toBe(true);
  });
});

// D4: two whole-run modes; the run does one or the other. Silent curve-wins
// hid the fact that --matrix was ignored.
describe("D4: --curve conflicts with --matrix", () => {
  it("errors naming both flags", () => {
    const args = parseArgs(["./Button.tsx", "--curve", "--matrix"]);
    expect(args.error).toBeDefined();
    expect(args.error).toContain("--curve");
    expect(args.error).toContain("--matrix");
  });

  it("errors in the reverse flag order", () => {
    expect(parseArgs(["./Button.tsx", "--matrix", "--curve"]).error).toBeDefined();
  });

  it("errors for the prop:type form of --curve", () => {
    expect(parseArgs(["./Button.tsx", "--curve", "items:array", "--matrix"]).error).toBeDefined();
  });

  it("does not error for either mode alone", () => {
    expect(parseArgs(["./Button.tsx", "--curve"]).error).toBeUndefined();
    expect(parseArgs(["./Button.tsx", "--matrix"]).error).toBeUndefined();
  });

  it("a disable resolves the conflict, matching --no-isolate/--no-react-compiler", () => {
    expect(parseArgs(["./Button.tsx", "--curve", "--matrix", "--no-matrix"]).error).toBeUndefined();
    expect(parseArgs(["./Button.tsx", "--curve", "--no-curve", "--matrix"]).error).toBeUndefined();
  });

  it("does not error for a disable paired with the other mode", () => {
    expect(parseArgs(["./Button.tsx", "--curve", "--no-matrix"]).error).toBeUndefined();
    expect(parseArgs(["./Button.tsx", "--no-curve", "--matrix"]).error).toBeUndefined();
  });
});

// D5: the reuse relaxation is only reachable if the CLI encodes a disable as
// `false` rather than dropping it.
describe("D5: CLI encodes mode disables as false", () => {
  it("--no-matrix resolves to false", () => {
    expect(resolveMatrixOption({ noMatrix: true })).toBe(false);
    expect(resolveMatrixOption({ matrix: true, noMatrix: true })).toBe(false);
  });

  it("--matrix resolves to true, absence to undefined", () => {
    expect(resolveMatrixOption({ matrix: true })).toBe(true);
    expect(resolveMatrixOption({})).toBeUndefined();
  });

  it("--no-curve resolves to false", () => {
    expect(resolveCurveOption({ noCurve: true })).toBe(false);
    expect(resolveCurveOption({ curve: true, noCurve: true })).toBe(false);
    expect(resolveCurveOption({ curve: "items:array", noCurve: true })).toBe(false);
  });

  it("--curve resolves to true or the parsed prop, absence to undefined", () => {
    expect(resolveCurveOption({ curve: true })).toBe(true);
    expect(resolveCurveOption({ curve: "items:array" })).toEqual({
      propName: "items",
      propKind: "array",
    });
    expect(resolveCurveOption({})).toBeUndefined();
  });

  it("a --no-matrix --check run is reuse-eligible end to end", () => {
    const args = parseArgs(["./Button.tsx", "--no-matrix", "--check"]);
    expect(args.error).toBeUndefined();
    expect(
      optionsAllowVerdictReuse({
        check: args.check,
        noCache: args.noCache,
        noBaseline: args.noBaseline,
        saveBaseline: args.saveBaseline,
        curveMode: resolveCurveOption(args),
        matrixMode: resolveMatrixOption(args),
        baselineEnv: args.baselineEnv,
      }),
    ).toBe(true);
  });
});
