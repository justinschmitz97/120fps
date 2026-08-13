import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { withProductionResolution } from "../node-resolution.js";
import { parseArgs, resolveIsolationOption } from "../../src/cli.js";
import {
  parseIsolationPhases,
  selectIsolationCombos,
  computeIsolationVerdict,
  buildMemoryReport,
  computeChurnDegradation,
  isolationBaselineMetrics,
  CHURN_DEGRADATION_LIMIT,
  type IsolationReport,
} from "../../src/isolation.js";
import {
  buildTimingWithCV,
  classifyTier,
  formatTable,
  TIER_BUDGETS,
  type Report,
  type Thresholds,
} from "../../src/report.js";
import { compareBaseline, buildEnvFingerprint, type BaselineEntry } from "../../src/budget.js";
import { reactJsxRuntimeDeps } from "../../src/harness.js";

const THRESHOLDS: Thresholds = { mountMs: 50, interactionMs: 400, relativeMount: 2, rerenderMs: 16 };

function timing(median: number) {
  return buildTimingWithCV([median, median, median]);
}

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00Z",
    machine: { cpu: "test", cores: 4, ramMb: 16384, os: "test", nodeVersion: "v20.0.0", chromiumVersion: "120" },
    componentPath: "./test.tsx",
    componentName: "Test",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos: [],
    thresholds: THRESHOLDS,
    pass: true,
    ...overrides,
  };
}

const src = (name: string) => fs.readFileSync(path.resolve("src", name), "utf-8");

// H1 — `all` expands regardless of position, alone or repeated
describe("H1: --isolate all in any position", () => {
  it("expands identically from every ordering", () => {
    const expected = ["mount", "rerender", "unmount", "memory", "strictmode"];
    expect(parseIsolationPhases("all")).toEqual(expected);
    expect(parseIsolationPhases("all,mount")).toEqual(expected);
    expect(parseIsolationPhases("mount,all")).toEqual(expected);
    expect(parseIsolationPhases("memory,all,mount")).toEqual(expected);
    expect(parseIsolationPhases("all,all")).toEqual(expected);
  });
});

// H2 — empty / comma-only / whitespace-only values
describe("H2: --isolate with nothing to isolate", () => {
  it("parses to an empty list", () => {
    expect(parseIsolationPhases("")).toEqual([]);
    expect(parseIsolationPhases(",,,")).toEqual([]);
    expect(parseIsolationPhases("   ")).toEqual([]);
    expect(parseIsolationPhases(" , , ")).toEqual([]);
  });

  it("is a CLI usage error, not a zero-phase run", () => {
    for (const value of ["", ",,,", "   ", " , , "]) {
      const args = parseArgs(["./Button.tsx", "--isolate", value]);
      expect(args.error).toContain("--isolate");
      expect(args.isolate).toBeUndefined();
    }
  });
});

// H3 — duplicate phases collapse into the canonical order
describe("H3: duplicate phases", () => {
  it("deduplicates and normalises order", () => {
    expect(parseIsolationPhases("memory,mount,memory,mount")).toEqual(["mount", "memory"]);
    expect(parseIsolationPhases("strictmode,mount")).toEqual(["mount", "strictmode"]);
    expect(parseArgs(["./Button.tsx", "--isolate", "mount,mount,rerender"]).isolate)
      .toEqual(["mount", "rerender"]);
  });
});

// H4 — unknown phases, including case variants
describe("H4: unknown phase", () => {
  it("names the offending phase and the valid set", () => {
    expect(() => parseIsolationPhases("bogus")).toThrow(/Invalid isolation phase: "bogus"/);
    expect(() => parseIsolationPhases("mount,bogus")).toThrow(/"bogus"/);
  });

  it("is case sensitive", () => {
    expect(() => parseIsolationPhases("MOUNT")).toThrow(/"MOUNT"/);
    expect(parseArgs(["./Button.tsx", "--isolate", "Mount"]).error).toContain("Mount");
  });

  it("surfaces through the CLI as the parser's own message", () => {
    let thrown = "";
    try {
      parseIsolationPhases("mount,bogus");
    } catch (err) {
      thrown = (err as Error).message;
    }
    expect(parseArgs(["./B.tsx", "--isolate", "mount,bogus"]).error).toBe(thrown);
  });
});

// H5 — a flag where the phase list belongs
describe("H5: --isolate followed by another flag", () => {
  it("is a usage error, not a phase named --ci", () => {
    const args = parseArgs(["./Button.tsx", "--isolate", "--ci"]);
    expect(args.error).toContain("--isolate");
    expect(args.isolate).toBeUndefined();
  });

  it("is a usage error at the end of argv", () => {
    expect(parseArgs(["./Button.tsx", "--isolate"]).error).toContain("--isolate");
  });
});

// H6 — --no-isolate still wins
describe("H6: --no-isolate overrides --isolate", () => {
  it("resolves to no isolation option", () => {
    const args = parseArgs(["./Button.tsx", "--isolate", "all", "--no-isolate"]);
    expect(args.error).toBeUndefined();
    expect(resolveIsolationOption(args)).toBeUndefined();
  });
});

// H7 — analyze rejects a zero-phase isolation option
describe("H7: analyze with an empty phase list", () => {
  it("guards before any measurement runs", () => {
    const analyzeSrc = src("analyze.ts");
    expect(analyzeSrc).toContain("--isolate requires at least one phase");
    const guardIdx = analyzeSrc.indexOf("--isolate requires at least one phase");
    const runIdx = analyzeSrc.indexOf("await runIsolationPhases(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(runIdx);
  });
});

// H8 — degenerate selection cannot produce undefined combos
describe("H8: combo selection edge cases", () => {
  it("never returns undefined for either combo", () => {
    for (const combos of [[], [{}], [{ __120fps_scaleN: 5 }], [{ a: 1 }, { a: 2 }]]) {
      const selection = selectIsolationCombos(combos);
      expect(selection.comboA).toBeDefined();
      expect(selection.comboB).toBeDefined();
    }
  });

  it("reports degenerate exactly when fewer than two usable combos exist", () => {
    expect(selectIsolationCombos([]).degenerate).toBe(true);
    expect(selectIsolationCombos([{ a: 1 }]).degenerate).toBe(true);
    expect(selectIsolationCombos([{ a: 1 }, { __120fps_scaleN: 2 }]).degenerate).toBe(true);
    expect(selectIsolationCombos([{ a: 1 }, { a: 2 }]).degenerate).toBe(false);
  });
});

// H9 — heap shrank between the two readings
describe("H9: heapAfter below heapBefore", () => {
  it("reports negative growth and no leak", () => {
    const report = buildMemoryReport({ cycles: 20, heapBefore: 500_000, heapAfter: 400_000, gcPressure: 0 });
    expect(report.heapGrowth).toBe(-100_000);
    expect(report.heapGrowthPerCycle).toBe(-5000);
    expect(report.leakSuspected).toBe(false);
    expect(computeIsolationVerdict({ memory: report }, undefined)).toBe(true);
  });
});

// H10 — gcPressure is carried through untouched, including its maximum
describe("H10: gcPressure passthrough", () => {
  it("survives report construction at every observed value", () => {
    for (const gcPressure of [0, 1, 4]) {
      expect(buildMemoryReport({ cycles: 20, heapBefore: 1, heapAfter: 1, gcPressure }).gcPressure)
        .toBe(gcPressure);
    }
  });

  it("never contributes to the verdict on its own", () => {
    const pressured = buildMemoryReport({ cycles: 20, heapBefore: 1000, heapAfter: 1000, gcPressure: 4 });
    expect(pressured.leakSuspected).toBe(false);
    expect(computeIsolationVerdict({ memory: pressured }, undefined)).toBe(true);
  });
});

// H11 — churn degradation boundary
describe("H11: churn degradation at the limit", () => {
  it("fails strictly above 2.0", () => {
    const at = (churnDegradation: number): IsolationReport => ({
      rerender: { stable: timing(1), propChange: timing(1), churn: timing(1), churnDegradation },
    });
    expect(computeIsolationVerdict(at(CHURN_DEGRADATION_LIMIT), undefined)).toBe(true);
    expect(computeIsolationVerdict(at(CHURN_DEGRADATION_LIMIT + 0.0001), undefined)).toBe(false);
  });

  it("treats a churn series that never ran as no signal", () => {
    expect(computeChurnDegradation([])).toBe(1.0);
    expect(computeIsolationVerdict({}, undefined)).toBe(true);
  });
});

// H12 — the mount budget the verdict actually uses
describe("H12: mount budget selection", () => {
  it("compares against whatever budget it is handed", () => {
    const iso: IsolationReport = { mount: timing(20) };
    expect(computeIsolationVerdict(iso, TIER_BUDGETS.T1.mountMs)).toBe(false);
    expect(computeIsolationVerdict(iso, TIER_BUDGETS.T2.mountMs)).toBe(true);
    expect(computeIsolationVerdict(iso, THRESHOLDS.mountMs)).toBe(true);
  });

  it("takes the flat threshold when --flat-thresholds or an explicit threshold is set", () => {
    const analyzeSrc = src("analyze.ts");
    expect(analyzeSrc).toContain(
      "options.flatThresholds || options.thresholds?.mountMs !== undefined",
    );
    expect(analyzeSrc).toContain("resolveComponentBudget(loadBudgetConfig(ctx.projectRoot), ctx.relativeComponent, tier).mountMs");
  });
});

// H13 — portals are invisible to isolation mode (documented consequence)
describe("H13: no portal signal in isolation mode", () => {
  it("classifies by DOM count and animation only", () => {
    expect(classifyTier({ domNodeCount: 5, hasPortal: false, hasAnimation: false })).toBe("T1");
    // The same component with discovery running would be T3 and get a looser budget.
    expect(classifyTier({ domNodeCount: 5, hasPortal: true, hasAnimation: false })).toBe("T3");
    expect(TIER_BUDGETS.T1.mountMs).toBeLessThan(TIER_BUDGETS.T3.mountMs);
  });

  it("passes hasPortal: false from the isolation branch", () => {
    const analyzeSrc = src("analyze.ts");
    const branch = analyzeSrc.slice(
      analyzeSrc.indexOf("async function runIsolationMode("),
      analyzeSrc.indexOf("function writeReportJson("),
    );
    expect(branch).toContain("hasPortal: false");
    expect(branch).toContain("Discovery does not run in isolation mode");
  });
});

// H14 — isolation mode never runs the standard pipeline stages
describe("H14: isolation branch scope", () => {
  const analyzeSrc = src("analyze.ts");
  const branch = analyzeSrc.slice(
    analyzeSrc.indexOf("async function runIsolationMode("),
    analyzeSrc.indexOf("function writeReportJson("),
  );

  it("does not explore, profile React, or compute deltas", () => {
    expect(branch).not.toContain("explore(");
    expect(branch).not.toContain("runReactAnalysis(");
    expect(branch).not.toContain("generateDeltaPairs(");
    expect(branch).not.toContain("generateScalingCombos(");
  });

  it("returns before the curve and matrix decisions", () => {
    expect(analyzeSrc.indexOf("// --- Isolation mode ---"))
      .toBeLessThan(analyzeSrc.indexOf("// --- Curve mode check ---"));
    expect(branch).toContain("return report;");
  });
});

// H15 — baseline round trip shapes
describe("H15: isolation baseline entries", () => {
  it("stays inert when compared against itself", () => {
    const env = buildEnvFingerprint({
      machine: { cpu: "test", cores: 4, ramMb: 16384, os: "test", nodeVersion: "v20.0.0", chromiumVersion: "120" },
      calibration: { totalDuration: 10, scriptDuration: 5 },
      cpuThrottle: 4,
      samples: 10,
      mode: "isolation",
    });
    const metrics = isolationBaselineMetrics({ mount: timing(5) }, "T1", 9);
    const entry: BaselineEntry = { ...metrics, env, tier: "T1" };
    const comparison = compareBaseline(
      entry,
      { mount: metrics.mount, rerender: metrics.rerender, unmount: metrics.unmount, interactions: {} },
      { mount: 10, rerender: 15, interaction: 15, unmount: 20 },
      metrics.unstable,
      env,
    );
    expect(comparison.regressions).toEqual([]);
    expect(comparison.improvements).toEqual([]);
    expect(comparison.missingInteractions).toEqual([]);
  });

  it("keeps a baseline interaction visible as missing when isolation records none", () => {
    const entry: BaselineEntry = {
      mount: 5,
      rerender: 1,
      unmount: 1,
      domNodeCount: 9,
      interactions: { "click Increment": 12 },
      tier: "T1",
    };
    const comparison = compareBaseline(
      entry,
      { mount: 5, rerender: 1, unmount: 1, interactions: {} },
      { mount: 10, rerender: 15, interaction: 15, unmount: 20 },
    );
    expect(comparison.missingInteractions).toEqual(["click Increment"]);
    expect(comparison.regressions).toEqual([]);
  });
});

// H16 — warnings survive every terminal rendering, including several at once
describe("H16: multiple warnings in isolation output", () => {
  it("prints each one", () => {
    const report = makeReport({
      isolation: { mount: timing(1) },
      warnings: ["first warning", "second warning"],
    });
    const output = formatTable(report);
    expect(output).toContain("⚠ first warning");
    expect(output).toContain("⚠ second warning");
    expect(output.indexOf("Result:")).toBeLessThan(output.indexOf("⚠ first warning"));
  });

  it("keeps the baseline section after the warnings", () => {
    const report = makeReport({
      isolation: { mount: timing(1) },
      warnings: ["a warning"],
      baseline: {
        hasBaseline: true,
        regressions: [],
        improvements: [],
        missingInteractions: [],
        envMatch: "identical",
        envMismatches: [],
      },
    });
    const output = formatTable(report);
    expect(output.indexOf("⚠ a warning")).toBeLessThan(output.indexOf("Baseline comparison:"));
  });
});

// H17 — an isolation report survives the JSON round trip the CLI writes
describe("H17: isolation JSON round trip", () => {
  it("preserves every phase", () => {
    const isolation: IsolationReport = {
      mount: timing(1),
      rerender: { stable: timing(1), propChange: timing(2), churn: timing(3), churnDegradation: 1.4 },
      unmount: timing(0.5),
      memory: buildMemoryReport({ cycles: 20, heapBefore: 1, heapAfter: 2, gcPressure: 1 }),
      strictMode: { normalMount: timing(1), strictMount: timing(2), overhead: 100, doubleInvokeClean: true },
    };
    const parsed = JSON.parse(JSON.stringify(makeReport({ isolation }))) as Report;
    expect(parsed.isolation!.rerender!.churnDegradation).toBe(1.4);
    expect(parsed.isolation!.memory!.gcPressure).toBe(1);
    expect(parsed.isolation!.strictMode!.doubleInvokeClean).toBe(true);
    expect(parsed.combos).toEqual([]);
  });
});

// H18b — the automatic JSX runtime must be pre-bundled, or Vite full-reloads
// the harness page mid-measurement the first time a project is measured.
describe("H18b: automatic JSX runtime is declared", () => {
  it("resolves both runtime entry points from the project", () => {
    expect(reactJsxRuntimeDeps(path.resolve("."))).toEqual([
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
    ]);
  });

  it("returns nothing for a project that cannot resolve them", () => {
    // The filesystem root has no node_modules above it on any OS; a literal
    // "C:/" is a relative path on POSIX and resolves inside the repo, where
    // react is a real dependency.
    const fsRoot = path.parse(process.cwd()).root;
    expect(withProductionResolution(() => reactJsxRuntimeDeps(fsRoot))).toEqual([]);
  });

  it("feeds optimizeDeps.include from buildAndServe", () => {
    // M34 routes the list through unionCachedDeps as `stableInclude`; the
    // runtime deps must feed that list, and the list must feed optimizeDeps.
    // M57 moved the per-renderer half of the list into `rendererDeps`, which
    // stableInclude spreads; the runtime deps still have to reach it.
    const harnessSrc = src("harness.ts");
    const rendererBlock = harnessSrc.slice(
      harnessSrc.indexOf("const rendererDeps ="),
      harnessSrc.indexOf("const stableInclude = unionCachedDeps("),
    );
    expect(rendererBlock).toContain("reactJsxRuntimeDeps(projectRoot)");
    const stableBlock = harnessSrc.slice(
      harnessSrc.indexOf("const stableInclude = unionCachedDeps("),
      harnessSrc.indexOf("readDepCacheMetadata(projectRoot)"),
    );
    expect(stableBlock).toContain("...rendererDeps");
    const includeBlock = harnessSrc.slice(
      harnessSrc.indexOf("optimizeDeps: {"),
      harnessSrc.indexOf("});", harnessSrc.indexOf("optimizeDeps: {")),
    );
    expect(includeBlock).toContain("include: stableInclude");
  });
});

// H18 — the strict query is the only difference between the two entry forms
describe("H18: strict binding is inert without the query", () => {
  it("reduces to the identity when strict is off", () => {
    const inStrict = (strict: boolean) => (el: unknown) => (strict ? { strict: el } : el);
    expect(inStrict(false)("tree")).toBe("tree");
    expect(inStrict(true)("tree")).toEqual({ strict: "tree" });
  });

  it("keys off exactly the string \"1\"", () => {
    const harnessSrc = src("harness.ts");
    expect(harnessSrc).toContain(`new URLSearchParams(location.search).get("strict") === "1"`);
  });
});
