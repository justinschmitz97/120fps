import path from "node:path";
import { generateCombinations } from "../../props/index.js";
import {
  loadBudgetConfig,
  resolveComponentBudget,
  buildEnvFingerprint,
  attachWrapperReport,
  classifyTier,
  type Report,
} from "../../report/index.js";
import {
  computeIsolationVerdict,
  isolationBaselineMetrics,
  parseIsolationPhases,
  runIsolationPhases,
  selectIsolationCombos,
  strictModeUnsupported,
  DEFAULT_MEMORY_CYCLES,
  VUE_STRICTMODE_ERROR,
} from "../../analysis/index.js";
import { type AnalyzeOptions, writeReportJson } from "../analyze.js";
import { applyBaselineWorkflow } from "../build-report.js";
import { type ModeContext, detectComponentName } from "../modes/context.js";
import { NO_PROPS_MEASURED_WARNING } from "../remedies.js";

// M83 #3 (element-plus-F4): per M46's precedent (a hostile run skips baseline
// comparison entirely), a hostile run's leak signal does not unilaterally
// fail the isolation run either — this is a coupling, not a retraction: the
// raw `isolation.memory.leakSuspected: true` signal is untouched.
export const LEAK_VERDICT_NOISE_QUALIFIED_WARNING = (cvPercent: number): string =>
  `leak suspected (heap growth crossed the per-cycle threshold), but this run's machine noise was ` +
  `hostile (probe CV ${Math.round(cvPercent)}%): the FAIL this would otherwise cause is withheld ` +
  "until a quieter run confirms it.";

export async function runIsolationMode(
  ctx: ModeContext,
  isolationOptions: NonNullable<AnalyzeOptions["isolation"]>,
): Promise<Report> {
  const { options, harness, thresholds } = ctx;
  const phases = parseIsolationPhases(isolationOptions.phases.join(","));
  if (phases.length === 0) {
    throw new Error(
      "--isolate requires at least one phase (mount, rerender, unmount, memory, strictmode, all)",
    );
  }
  // The CLI rejects this first; the guard is here for direct API callers, whose
  // Vue "strict" pass would otherwise re-measure the identical page and report
  // 0% overhead as a clean double-invoke.
  if (strictModeUnsupported(phases, [harness.componentPath])) {
    throw new Error(VUE_STRICTMODE_ERROR);
  }

  const isolationCombos =
    // M100 (calcom-F4): getSchemas() is called on both branches. A fixture or
    // a composed scene still does not build its combos from the schemas, but
    // extraction's diagnostics are the same ones the dry run printed and were
    // dropped here for exactly the runs that measure `{}`.
    ctx.useFixture || ctx.composed
      ? (await ctx.getSchemas(), [{}])
      : generateCombinations(await ctx.getSchemas());
  // M100 MUST 3 covers this path too (review gap 5): --isolate on a fixture or
  // a composed target measures `{}` exactly as combo mode does, and used to
  // say nothing about it.
  if (ctx.useFixture || ctx.composed) {
    const isolationSchemas = await ctx.getSchemas();
    if (isolationSchemas.length > 0) {
      ctx.runWarnings.push(NO_PROPS_MEASURED_WARNING(ctx.useFixture));
    }
  }
  const selection = selectIsolationCombos(isolationCombos);

  ctx.progress(`isolation: ${phases.join(", ")}`);
  const run = await runIsolationPhases(harness, {
    phases,
    comboA: selection.comboA,
    comboB: selection.comboB,
    degenerate: selection.degenerate,
    samples: ctx.samples,
    cpuThrottle: ctx.cpuThrottle,
    memoryCycles: isolationOptions.memoryCycles ?? DEFAULT_MEMORY_CYCLES,
    pool: ctx.pool,
    // M73: font-settle and session warnings raised inside a phase reach the
    // same sink every other phase already uses.
    onWarning: ctx.onWarning,
  });

  // Discovery does not run in isolation mode, so there is no portal signal.
  const tier = classifyTier({
    domNodeCount: run.domNodeCount ?? 0,
    hasPortal: false,
    hasAnimation: run.hasAnimation ?? false,
  });
  const flatMountBudget =
    options.flatThresholds || options.thresholds?.mountMs !== undefined;
  const mountBudgetMs = flatMountBudget
    ? thresholds.mountMs
    : resolveComponentBudget(loadBudgetConfig(ctx.projectRoot), ctx.relativeComponent, tier).mountMs;

  const componentName = detectComponentName(ctx.metadataPath, ctx.options.target);
  // M83 #3 (element-plus-F4): `pass` is a placeholder here — isolation-mode
  // reports always carry `combos: []`, so `attachHarnessContext`'s noise
  // computation (unstableFraction) is structurally 0 for this mode, and only
  // `probeCv` can classify the run. Computing the real verdict before that
  // classification exists means a hostile run's leak signal has no noise
  // level to check against. `report.pass` is reassigned below, after
  // attachHarnessContext has populated `report.noise`.
  const report: Report = {
    version: 1,
    timestamp: new Date().toISOString(),
    machine: ctx.machine,
    componentPath: ctx.componentPath,
    componentName,
    calibration: ctx.calibration,
    combos: [],
    thresholds,
    pass: false,
    isolation: run.isolation,
    ...(harness.nextJsShims && harness.nextJsShims.length > 0
      ? { nextJsShims: harness.nextJsShims }
      : {}),
  };

  if (ctx.useFixture) {
    report.fixturePath = ctx.inputIsFixture ? ctx.componentPath : ctx.fixturePath;
    report.fixtureAutoDetected = ctx.fixtureAutoDetected;
  }
  if (ctx.composed) {
    report.autoComposition = true;
    report.compositionTree = ctx.compositionTree!;
  }

  if (ctx.wrapper) attachWrapperReport(report, ctx.wrapper);
  ctx.attachHarnessContext(report);
  if (run.warnings.length > 0) {
    report.warnings = [...(report.warnings ?? []), ...run.warnings];
  }

  report.pass = computeIsolationVerdict(run.isolation, mountBudgetMs, report.noise?.level);
  // The memory branch's FAIL was withheld because the run's own sentinel
  // called it hostile: the raw signal (isolation.memory.leakSuspected) stays
  // true in the JSON, unchanged — only the FAIL rollup is qualified, and the
  // report says why.
  if (run.isolation.memory?.leakSuspected && report.noise?.level === "hostile") {
    report.warnings = [
      ...(report.warnings ?? []),
      LEAK_VERDICT_NOISE_QUALIFIED_WARNING(report.noise.signals.probeCv),
    ];
  }

  applyBaselineWorkflow(
    report,
    isolationBaselineMetrics(run.isolation, tier, run.domNodeCount ?? 0),
    {
      options,
      projectRoot: ctx.projectRoot,
      relativeComponent: ctx.relativeComponent,
      componentDir: path.dirname(ctx.resolvedPath),
      currentEnv: buildEnvFingerprint({
        machine: ctx.machine,
        calibration: ctx.calibration,
        cpuThrottle: ctx.cpuThrottle,
        samples: ctx.samples,
        mode: "isolation",
        framework: ctx.framework,
        // M82: cssReport is now always constructed, even for "none" — gate on
        // files.length so a no-CSS project's fingerprint bytes stay unchanged.
        ...(ctx.cssReport && ctx.cssReport.files.length > 0 ? { css: ctx.cssReport.files } : {}),
        ...(ctx.wrapper ? { wrapper: ctx.wrapper.path } : {}),
        ...(harness.reactCompiler?.active ? { reactCompiler: true } : {}),
      }),
      envPolicy: options.baselineEnv ?? "normalize",
      ...(options.saveBaseline ? { sourceFingerprint: await ctx.getSourceFingerprint() } : {}),
    },
  );

  // M115 C1: the run's own breakdown, on the report the run returns.
  report.phaseTimings = ctx.phaseClock.timings();
  writeReportJson(report, options.jsonPath);

  return report;
}
