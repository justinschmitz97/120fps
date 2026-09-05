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

// Only the FAIL rollup is qualified; the raw isolation.memory.leakSuspected signal stays true.
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
  // The CLI rejects this first; a direct API caller's Vue strict pass would report 0% overhead.
  if (strictModeUnsupported(phases, [harness.componentPath])) {
    throw new Error(VUE_STRICTMODE_ERROR);
  }

  const isolationCombos =
    // getSchemas() runs on both branches so extraction diagnostics still reach ctx.runWarnings.
    ctx.useFixture || ctx.composed
      ? (await ctx.getSchemas(), [{}])
      : generateCombinations(await ctx.getSchemas());
  // --isolate measures `{}` here as combo mode does; real props are announced, not dropped.
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
    // Font-settle and session warnings raised inside a phase reach the run's shared sink.
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
  // pass is a placeholder: it is reassigned once attachHarnessContext has populated report.noise.
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
        // cssReport exists even for "none"; gate on files.length to keep the bytes stable.
        ...(ctx.cssReport && ctx.cssReport.files.length > 0 ? { css: ctx.cssReport.files } : {}),
        ...(ctx.wrapper ? { wrapper: ctx.wrapper.path } : {}),
        ...(harness.reactCompiler?.active ? { reactCompiler: true } : {}),
      }),
      envPolicy: options.baselineEnv ?? "normalize",
      ...(options.saveBaseline ? { sourceFingerprint: await ctx.getSourceFingerprint() } : {}),
    },
  );

  report.phaseTimings = ctx.phaseClock.timings();
  writeReportJson(report, options.jsonPath);

  return report;
}
