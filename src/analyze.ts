import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { buildAndServe, detectGlobalCss, detectScaleExport, detectWrapper, findProjectRoot, type HarnessResult } from "./harness.js";
import { attachPageErrorCapture, enrichTimeoutError } from "./page-errors.js";
import { extractProps, extractExports, extractAllProps, detectScalingProps, type ScalingPropMatch } from "./prop-gen.js";
import { inferComposition, type CompositionTree } from "./composition.js";
import { detectFramework, runReactAnalysis, hasReactWarning, type ReactOptimizations } from "./react-profiler.js";
import { generateCombinations, generateDeltaPairs, generateScalingCombos, generatePropMatrix, shouldAutoActivateMatrix, type PropCombination } from "./prop-gen-values.js";
import { applyWrapperViewport, measureMount, measureRerender, measureWrapperOverhead, settleStyles, FONT_SETTLE_WARNING, HARNESS_NAV_WAIT, type MountResult, type RerenderResult } from "./measure.js";
import { explore, type ExploreResult } from "./explorer.js";
import {
  createCalibrationTrace,
  computeScalingCurve,
  attributeCost,
  type ScalingCurve,
} from "./metrics.js";
import {
  loadBudgetConfig,
  loadBaseline,
  saveBaseline as saveBaselineFile,
  resolveComponentBudget,
  resolveTolerances,
  compareBaseline,
  buildEnvFingerprint,
  envAdvisory,
  type BaselineEntry,
  type BaselineEnvPolicy,
  type BaselineMetrics,
} from "./budget.js";
import {
  computeIsolationVerdict,
  isolationBaselineMetrics,
  parseIsolationPhases,
  runIsolationPhases,
  selectIsolationCombos,
  DEFAULT_MEMORY_CYCLES,
} from "./isolation.js";
import {
  attachWrapperReport,
  buildTimingWithCV,
  buildCurveReport,
  computeCurveVerdict,
  classifyTier,
  computeVerdict,
  DEFAULT_THRESHOLDS,
  TIER_BUDGETS,
  type CalibrationResult,
  type ComboReport,
  type InteractionReport,
  type MachineInfo,
  type PropDelta,
  type Report,
  buildMatrixReport,
  type MatrixAxis,
  type MatrixReport,
  type ScalingCurveReport,
  type TierBudget,
  type Thresholds,
  type TimingWithCV,
  type CssReport,
  type EnvFingerprint,
  type WrapperReport,
} from "./report.js";

export interface AnalyzeOptions {
  samples?: number;
  cpuThrottle?: number;
  warmupRuns?: number;
  seed?: number;
  jsonPath?: string;
  ci?: boolean;
  thresholds?: Partial<Thresholds>;
  fixturePath?: string;
  scalePoints?: number[];
  skipDeltas?: boolean;
  skipAutoScale?: boolean;
  flatThresholds?: boolean;
  skipAttribution?: boolean;
  skipAutoCompose?: boolean;
  skipReactAnalysis?: boolean;
  framework?: "react" | "vanilla" | "auto";
  noShims?: boolean;
  curveMode?: boolean | { propName: string; propKind: "array" | "number" };
  matrixMode?: boolean;
  saveBaseline?: boolean;
  check?: boolean;
  noBaseline?: boolean;
  baselineEnv?: BaselineEnvPolicy;
  isolation?: { phases: string[]; memoryCycles?: number };
  wrapPath?: string;
  noWrap?: boolean;
  cssFiles?: string[];
  noCss?: boolean;
  reactCompiler?: boolean;
}

export interface BuildReportInput {
  componentPath: string;
  componentName: string;
  machine: MachineInfo;
  calibration: CalibrationResult;
  mounts: MountResult[];
  explores: ExploreResult[];
  heapDeltas: number[];
  thresholds: Thresholds;
  fixturePath?: string;
  fixtureAutoDetected?: boolean;
  rerenders?: RerenderResult[];
  flatThresholds?: boolean;
  explicitThresholds?: Partial<Record<keyof TierBudget, boolean>>;
  skipAttribution?: boolean;
  autoComposition?: boolean;
  compositionTree?: import("./composition.js").CompositionTree;
  nextJsShims?: string[];
  scalingCurveReport?: ScalingCurveReport;
  matrixReport?: import("./report.js").MatrixReport;
}

export function buildReport(input: BuildReportInput): Report {
  const combos: ComboReport[] = [];

  for (const mount of input.mounts) {
    const exploreResult = input.explores.find(
      (e) => e.comboIndex === mount.comboIndex,
    );

    const interactions: InteractionReport[] = [];
    if (exploreResult) {
      for (const edge of exploreResult.graph.edges) {
        const report: InteractionReport = {
          selector: edge.interaction.selector,
          type: edge.interaction.type,
          label: edge.interaction.label,
          timing: buildTimingWithCV(edge.samples),
          relativeTiming:
            input.calibration.totalDuration > 0
              ? computeMedianFromSamples(edge.samples) /
                input.calibration.totalDuration
              : 0,
        };
        if (edge.interaction.portal) report.portal = true;
        if (edge.stressPattern) report.stressPattern = edge.stressPattern;
        interactions.push(report);
      }
    }

    const relativeMount =
      input.calibration.totalDuration > 0
        ? mount.mount.median / input.calibration.totalDuration
        : 0;

    const rerenderResult = input.rerenders?.find(
      (r) => r.comboIndex === mount.comboIndex,
    );

    const rerenderTiming = rerenderResult
      ? buildTimingWithCV(rerenderResult.stable.samples)
      : buildTimingWithCV([0]);

    const combo: ComboReport = {
      comboIndex: mount.comboIndex,
      props: mount.props as Record<string, unknown>,
      mount: buildTimingWithCV(mount.mount.samples),
      unmount: buildTimingWithCV(mount.unmount.samples),
      rerender: rerenderTiming,
      domNodeCount: mount.domNodeCount,
      heapDelta: input.heapDeltas[mount.comboIndex] ?? 0,
      interactions,
      scalingCurve: null,
      relativeMount,
      verdict: "pass",
    };

    if (rerenderResult?.change) {
      combo.rerenderChange = buildTimingWithCV(rerenderResult.change.samples);
    }

    if (!input.skipAttribution && mount.mountTraces && mount.mountTraces.length > 0) {
      const allEvents = mount.mountTraces.flat();
      combo.costAttribution = attributeCost(allEvents);
    }

    combo.verdict = computeVerdict(combo, input.thresholds);
    combos.push(combo);
  }

  const distinctDomSizes = new Set(combos.map((c) => c.domNodeCount));
  if (distinctDomSizes.size >= 2) {
    const points = combos.map((c) => ({ n: c.domNodeCount, metric: c.mount.median }));
    const curve = computeScalingCurve(points);
    for (const combo of combos) {
      combo.scalingCurve = curve;
    }

    const rerenderPoints = combos.map((c) => ({ n: c.domNodeCount, metric: c.rerender.median }));
    const rerenderCurve = computeScalingCurve(rerenderPoints);
    for (const combo of combos) {
      combo.rerenderScalingCurve = rerenderCurve;
    }
  }

  if (!input.flatThresholds) {
    for (const combo of combos) {
      const isScaleCombo = "__120fps_scaleN" in combo.props;
      const hasPortal = combo.interactions.some((i) => i.portal === true);
      const hasScaling = combo.scalingCurve != null || combo.rerenderScalingCurve != null;
      const mountResult = input.mounts.find((m) => m.comboIndex === combo.comboIndex);
      const hasAnimation = mountResult?.hasAnimation ?? false;
      const tier = classifyTier({ domNodeCount: combo.domNodeCount, hasPortal, hasScaling, hasAnimation });
      combo.tier = tier;
      combo.hasAnimation = hasAnimation;
      if (isScaleCombo) {
        combo.verdict = "pass";
      } else {
        const tierBudget = TIER_BUDGETS[tier];
        const effectiveBudget: TierBudget = {
          mountMs: input.explicitThresholds?.mountMs ? input.thresholds.mountMs : tierBudget.mountMs,
          rerenderMs: input.explicitThresholds?.rerenderMs ? input.thresholds.rerenderMs : tierBudget.rerenderMs,
          interactionMs: input.explicitThresholds?.interactionMs ? input.thresholds.interactionMs : tierBudget.interactionMs,
        };
        combo.verdict = computeVerdict(combo, input.thresholds, { tierBudget: effectiveBudget });
      }
    }
  }

  const pass = combos.every((c) => c.verdict !== "fail");

  const report: Report = {
    version: 1,
    timestamp: new Date().toISOString(),
    machine: input.machine,
    componentPath: input.componentPath,
    componentName: input.componentName,
    calibration: input.calibration,
    combos,
    thresholds: input.thresholds,
    pass,
  };

  if (input.fixturePath !== undefined) {
    report.fixturePath = input.fixturePath;
    report.fixtureAutoDetected = input.fixtureAutoDetected ?? false;
  }

  if (!input.flatThresholds) {
    report.tieredBudgets = true;
  }

  if (input.autoComposition) {
    report.autoComposition = true;
  }
  if (input.compositionTree) {
    report.compositionTree = input.compositionTree;
  }

  if (input.nextJsShims && input.nextJsShims.length > 0) {
    report.nextJsShims = input.nextJsShims;
  }

  if (input.scalingCurveReport) {
    report.scalingCurveReport = input.scalingCurveReport;
  }

  if (input.matrixReport) {
    report.matrixReport = input.matrixReport;
  }

  return report;
}

interface BaselineWorkflowContext {
  options: AnalyzeOptions;
  projectRoot: string;
  relativeComponent: string;
  componentDir: string;
  currentEnv: EnvFingerprint;
  envPolicy: BaselineEnvPolicy;
}

// Shared by every output mode: the isolation branch returns before the combo
// path would reach its own copy, and both compare the same three metrics.
function applyBaselineWorkflow(
  report: Report,
  metrics: BaselineMetrics | undefined,
  ctx: BaselineWorkflowContext,
): void {
  const baselinePath = path.join(ctx.projectRoot, "120fps-baseline.json");

  if (ctx.options.check && !ctx.options.noBaseline) {
    const baseline = loadBaseline(baselinePath);
    const entry = baseline?.entries[ctx.relativeComponent];
    if (entry) {
      const tol = resolveTolerances(loadBudgetConfig(ctx.projectRoot));
      const comparison = compareBaseline(
        entry,
        {
          mount: metrics?.mount ?? 0,
          rerender: metrics?.rerender ?? 0,
          unmount: metrics?.unmount ?? 0,
          interactions: metrics?.interactions ?? {},
        },
        tol,
        metrics?.unstable ?? new Set<string>(),
        ctx.envPolicy === "ignore" ? undefined : ctx.currentEnv,
      );
      report.baseline = comparison;
      if (comparison.regressions.length > 0) {
        report.pass = false;
      }
      const advisory = envAdvisory(comparison.envMatch, comparison.envMismatches, ctx.envPolicy);
      if (advisory.warning) {
        report.warnings = [...(report.warnings ?? []), advisory.warning];
      }
      if (advisory.fail) {
        report.pass = false;
      }
    } else {
      const legacyWarning = legacyBaselineWarning(ctx.projectRoot, ctx.componentDir);
      if (legacyWarning) {
        process.stderr.write(`Warning: ${legacyWarning}\n`);
      }
    }
  }

  if (ctx.options.saveBaseline && metrics) {
    const entry: BaselineEntry = {
      mount: metrics.mount,
      rerender: metrics.rerender,
      unmount: metrics.unmount,
      domNodeCount: metrics.domNodeCount,
      interactions: metrics.interactions,
      tier: metrics.tier,
      env: ctx.currentEnv,
    };
    saveBaselineFile(baselinePath, entry, ctx.relativeComponent);
  }
}

function writeReportJson(report: Report, jsonPath: string | undefined): void {
  const target = path.resolve(jsonPath ?? "120fps-report.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(report, mapReplacer, 2), "utf-8");
}

function computeMedianFromSamples(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function detectComponentName(componentPath: string): string {
  const source = fs.readFileSync(componentPath, "utf-8");

  const defaultFn = source.match(
    /export\s+default\s+function\s+([A-Z]\w*)/,
  );
  if (defaultFn) return defaultFn[1];

  const defaultConst = source.match(
    /export\s+default\s+([A-Z]\w*)/,
  );
  if (defaultConst) return defaultConst[1];

  const namedExport = source.match(
    /export\s+(?:const|function)\s+([A-Z]\w*)/,
  );
  if (namedExport) return namedExport[1];

  const reExport = source.match(
    /export\s+\{\s*([A-Z]\w*)\s*\}/,
  );
  if (reExport) return reExport[1];

  const basename = path.basename(componentPath, path.extname(componentPath));
  return basename.charAt(0).toUpperCase() + basename.slice(1);
}

async function collectMachineInfo(
  chromiumVersion: string,
): Promise<MachineInfo> {
  const cpus = os.cpus();
  return {
    cpu: cpus.length > 0 ? cpus[0].model : "unknown",
    cores: cpus.length,
    ramMb: Math.round(os.totalmem() / (1024 * 1024)),
    os: `${os.type()} ${os.release()}`,
    nodeVersion: process.version,
    chromiumVersion,
  };
}

export async function analyze(
  componentPath: string,
  options: AnalyzeOptions = {},
): Promise<Report> {
  const resolvedPath = path.resolve(componentPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Component file not found: ${componentPath}`);
  }

  const thresholds: Thresholds = {
    ...DEFAULT_THRESHOLDS,
    ...options.thresholds,
  };

  const samples = options.samples ?? 10;
  const cpuThrottle = options.cpuThrottle ?? 4;
  const warmupRuns = options.warmupRuns ?? 2;
  const seed = options.seed ?? 42;

  let fixturePath: string | undefined = options.fixturePath;
  let fixtureAutoDetected = false;
  const inputIsFixture = isFixturePath(componentPath);

  if (inputIsFixture) {
    fixturePath = componentPath;
  } else if (!fixturePath) {
    const detected = detectFixture(resolvedPath);
    if (detected) {
      fixturePath = detected;
      fixtureAutoDetected = true;
    }
  }

  if (fixturePath && !inputIsFixture) {
    const resolvedFixture = path.resolve(fixturePath);
    if (!fs.existsSync(resolvedFixture)) {
      throw new Error(`Fixture file not found: ${fixturePath}`);
    }
  }

  let compositionTree: CompositionTree | undefined;
  let componentExports: import("./composition.js").ExportInfo[] | undefined;
  if (!fixturePath && !inputIsFixture && !options.skipAutoCompose) {
    componentExports = await extractExports(resolvedPath);
    if (componentExports.length > 1) {
      const allSchemas = await extractAllProps(resolvedPath);
      const tree = inferComposition(componentExports, allSchemas);
      if (tree) compositionTree = tree;
    }
  }

  const useFixture = fixturePath !== undefined;
  const useComposition = compositionTree !== undefined;
  const harnessPath = useFixture ? fixturePath! : componentPath;
  const metadataPath = inputIsFixture ? componentPath : resolvedPath;

  const { projectRoot, relativeComponent } = resolveProjectPaths(resolvedPath);
  const { wrapPath, wrapAutoDetected } = resolveWrapPath(options, projectRoot);
  const resolvedCss = resolveCssFiles(options, projectRoot);
  const cssReport: CssReport | undefined =
    resolvedCss.files.length > 0
      ? {
          files: resolvedCss.files.map((f) => path.relative(projectRoot, f).replace(/\\/g, "/")),
          autoDetected: resolvedCss.autoDetected,
        }
      : undefined;
  let fontsSettled = true;

  const attachHarnessContext = (report: Report): void => {
    if (cssReport) report.css = cssReport;
    const compiler = harness?.reactCompiler;
    if (compiler && (compiler.detected || compiler.active)) {
      report.reactCompiler = {
        active: compiler.active,
        detected: compiler.detected,
        ...(compiler.version ? { version: compiler.version } : {}),
      };
    }
    if (compiler?.warning) {
      report.warnings = [...(report.warnings ?? []), compiler.warning];
    }
    if (!fontsSettled) {
      report.warnings = [...(report.warnings ?? []), FONT_SETTLE_WARNING];
    }
  };

  let harness: HarnessResult | undefined;
  let browser: Browser | undefined;

  try {
    const harnessOpts: import("./harness.js").BuildHarnessOptions = {
      ...(useComposition ? { composition: compositionTree!, exports: componentExports } : {}),
      ...(options.noShims ? { noShims: true } : {}),
      ...(wrapPath ? { wrapPath } : {}),
      ...(resolvedCss.files.length > 0 ? { cssFiles: resolvedCss.files } : {}),
      ...(options.reactCompiler !== undefined ? { reactCompiler: options.reactCompiler } : {}),
    };
    harness = await buildAndServe(harnessPath, harnessOpts);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const pageErrors = attachPageErrorCapture(page);
    const cdp = await page.context().newCDPSession(page);

    const chromiumVersion = browser.version();
    const machine = await collectMachineInfo(chromiumVersion);

    await page.goto(harness.url, { waitUntil: HARNESS_NAV_WAIT });
    try {
      await page.waitForFunction(
        () => typeof (window as any).__120fps === "object",
        undefined,
        { timeout: 30000 },
      );
    } catch (err) {
      throw enrichTimeoutError(err, pageErrors, "component harness");
    }

    await applyWrapperViewport(page);
    fontsSettled = await settleStyles(page, harness);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });

    const calibrationMetrics = await createCalibrationTrace(page, cdp);
    const calibration: CalibrationResult = {
      totalDuration: calibrationMetrics.totalDuration,
      scriptDuration: calibrationMetrics.scriptDuration,
    };

    if (calibration.totalDuration === 0) {
      throw new Error("Calibration produced zero duration — measurement environment is broken");
    }

    let wrapper: WrapperReport | undefined;
    if (wrapPath) {
      const overhead = await measureWrapperOverhead(page, cdp, samples);
      wrapper = {
        path: path.relative(projectRoot, wrapPath).replace(/\\/g, "/"),
        autoDetected: wrapAutoDetected,
        overheadMs: overhead.overheadMs,
        domNodes: overhead.domNodes,
      };
    }

    await browser.close();
    browser = undefined;

    let combos: PropCombination[];
    let schemas: import("./prop-gen.js").PropSchema[] | undefined;
    const resolvedHarnessPath = path.resolve(harnessPath);
    const fixtureHasScale = useFixture && detectScaleExport(resolvedHarnessPath);

    // --- Isolation mode ---
    if (options.isolation) {
      const phases = parseIsolationPhases(options.isolation.phases.join(","));
      if (phases.length === 0) {
        throw new Error(
          "--isolate requires at least one phase (mount, rerender, unmount, memory, strictmode, all)",
        );
      }

      const isolationCombos =
        useFixture || useComposition
          ? [{}]
          : generateCombinations(await extractProps(harness.componentPath));
      const selection = selectIsolationCombos(isolationCombos);

      const run = await runIsolationPhases(harness, {
        phases,
        comboA: selection.comboA,
        comboB: selection.comboB,
        degenerate: selection.degenerate,
        samples,
        cpuThrottle,
        memoryCycles: options.isolation.memoryCycles ?? DEFAULT_MEMORY_CYCLES,
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
        : resolveComponentBudget(loadBudgetConfig(projectRoot), relativeComponent, tier).mountMs;

      const componentName = detectComponentName(metadataPath);
      const report: Report = {
        version: 1,
        timestamp: new Date().toISOString(),
        machine,
        componentPath,
        componentName,
        calibration,
        combos: [],
        thresholds,
        pass: computeIsolationVerdict(run.isolation, mountBudgetMs),
        isolation: run.isolation,
        ...(harness.nextJsShims && harness.nextJsShims.length > 0
          ? { nextJsShims: harness.nextJsShims }
          : {}),
      };

      if (useFixture) {
        report.fixturePath = inputIsFixture ? componentPath : fixturePath;
        report.fixtureAutoDetected = fixtureAutoDetected;
      }
      if (useComposition) {
        report.autoComposition = true;
        report.compositionTree = compositionTree!;
      }

      if (wrapper) attachWrapperReport(report, wrapper);
      attachHarnessContext(report);
      if (run.warnings.length > 0) {
        report.warnings = [...(report.warnings ?? []), ...run.warnings];
      }

      applyBaselineWorkflow(
        report,
        isolationBaselineMetrics(run.isolation, tier, run.domNodeCount ?? 0),
        {
          options,
          projectRoot,
          relativeComponent,
          componentDir: path.dirname(resolvedPath),
          currentEnv: buildEnvFingerprint({
            machine,
            calibration,
            cpuThrottle,
            samples,
            mode: "isolation",
            ...(cssReport ? { css: cssReport.files } : {}),
            ...(wrapper ? { wrapper: wrapper.path } : {}),
            ...(harness.reactCompiler?.active ? { reactCompiler: true } : {}),
          }),
          envPolicy: options.baselineEnv ?? "normalize",
        },
      );

      writeReportJson(report, options.jsonPath);

      return report;
    }

    // --- Curve mode check ---
    const curveDisabled = options.curveMode === false;
    let curveMatch: ScalingPropMatch | undefined;
    let curveExplicit: { propName: string; propKind: "array" | "number" } | undefined;

    if (!curveDisabled && !useFixture && !useComposition) {
      if (typeof options.curveMode === "object") {
        curveExplicit = options.curveMode;
      } else {
        const tempSchemas = await extractProps(harness.componentPath);
        const matches = detectScalingProps(tempSchemas);
        if (matches.length > 0 && options.curveMode !== false) {
          curveMatch = matches[0];
          schemas = tempSchemas;
        }
      }
    }

    const activateCurve = !!(curveExplicit || curveMatch);

    if (activateCurve) {
      if (!schemas) schemas = await extractProps(harness.componentPath);
      const curveScalePoints = options.scalePoints ?? [1, 3, 5, 10, 20, 50];
      const matchKind = curveExplicit ? (curveExplicit.propKind === "number" ? "numeric" as const : "array" as const) : curveMatch!.kind;
      const match: ScalingPropMatch = curveMatch ?? {
        schema: schemas.find((s) => s.name === curveExplicit!.propName) ?? { name: curveExplicit!.propName, kind: curveExplicit!.propKind, values: [], required: false },
        kind: matchKind,
        reason: "explicit --curve flag",
      };
      const scaleCombos = generateScalingCombos(schemas, match, curveScalePoints);

      const curveMounts = await measureMount(harness, {
        samples,
        cpuThrottle,
        warmupRuns,
        combos: scaleCombos,
      });
      const curveRerenders = await measureRerender(harness, {
        samples,
        cpuThrottle,
        warmupRuns,
        combos: scaleCombos,
      });
      const curveExplores = await explore(harness, {
        samples: Math.min(samples, 5),
        cpuThrottle,
        warmupRuns,
        seed: options.seed ?? 42,
        combos: scaleCombos,
        maxWallClockMs: 30000,
      });

      const curveHeapDeltas = curveMounts.map((m) => m.heapDelta ?? 0);
      const componentName = detectComponentName(metadataPath);

      const curveReport = buildCurveReport({
        propName: match.schema.name,
        propKind: match.kind === "numeric" ? "number" : "array",
        reason: match.reason,
        scalePoints: curveScalePoints,
        mounts: curveMounts,
        rerenders: curveRerenders,
        explores: curveExplores,
        heapDeltas: curveHeapDeltas,
        calibration,
        thresholds,
        skipAttribution: options.skipAttribution,
      });

      const curveVerdict = computeCurveVerdict(curveReport.points, curveReport.mountCurve, thresholds);
      const pass = curveVerdict !== "fail";

      const report: Report = {
        version: 1,
        timestamp: new Date().toISOString(),
        machine,
        componentPath,
        componentName,
        calibration,
        combos: [],
        thresholds,
        pass,
        scalingCurveReport: curveReport,
        ...(harness.nextJsShims && harness.nextJsShims.length > 0 ? { nextJsShims: harness.nextJsShims } : {}),
      };

      if (wrapper) attachWrapperReport(report, wrapper);
      attachHarnessContext(report);

      writeReportJson(report, options.jsonPath);

      return report;
    }

    // --- Matrix mode check ---
    const matrixDisabled = options.matrixMode === false;
    let activateMatrix = false;

    if (!matrixDisabled && !useFixture && !useComposition && !activateCurve) {
      if (!schemas) schemas = await extractProps(harness.componentPath);
      if (options.matrixMode === true) {
        activateMatrix = true;
      } else {
        activateMatrix = shouldAutoActivateMatrix(schemas);
      }
    }

    if (activateMatrix) {
      if (!schemas) schemas = await extractProps(harness.componentPath);
      const matrixCombos = generatePropMatrix(schemas);
      const matrixAxes: MatrixAxis[] = schemas
        .filter((s) => s.kind === "boolean" || (s.kind === "union" && s.values.length >= 1 && s.values.length <= 8))
        .map((s) => ({
          propName: s.name,
          values: s.kind === "boolean" ? [false, true] : s.values,
        }));

      const matrixMounts = await measureMount(harness, {
        samples,
        cpuThrottle,
        warmupRuns,
        combos: matrixCombos,
      });
      const matrixRerenders = await measureRerender(harness, {
        samples,
        cpuThrottle,
        warmupRuns,
        combos: matrixCombos,
      });

      // Explore only hot cells (top 5 by mount median)
      const sortedMounts = [...matrixMounts].sort((a, b) => b.mount.median - a.mount.median);
      const hotIndices = new Set(sortedMounts.slice(0, 5).map((m) => m.comboIndex));
      const hotCombos = matrixCombos.filter((_, i) => hotIndices.has(i));
      const matrixExplores = hotCombos.length > 0
        ? await explore(harness, {
            samples: Math.min(samples, 5),
            cpuThrottle,
            warmupRuns,
            seed: options.seed ?? 42,
            combos: hotCombos,
            maxWallClockMs: 30000,
          })
        : [];

      // Delta analysis for compound effects
      let matrixDeltas: PropDelta[] | undefined;
      if (!options.skipDeltas && schemas.length > 0) {
        const deltaPairs = generateDeltaPairs(schemas);
        const measured = new Map<string, { mount: MountResult; rerender?: RerenderResult }>();
        for (const m of matrixMounts) {
          measured.set(JSON.stringify(m.props), { mount: m, rerender: matrixRerenders.find((r) => r.comboIndex === m.comboIndex) });
        }
        const missingPairs = deltaPairs.filter((p) => !measured.has(JSON.stringify(p.baseCombo)) || !measured.has(JSON.stringify(p.flipCombo)));
        if (missingPairs.length > 0) {
          const missingCombos = [...new Set(missingPairs.flatMap((p) => [JSON.stringify(p.baseCombo), JSON.stringify(p.flipCombo)]))].filter((k) => !measured.has(k)).map((k) => JSON.parse(k) as PropCombination);
          if (missingCombos.length > 0) {
            const extraMounts = await measureMount(harness, { samples, cpuThrottle, warmupRuns, combos: missingCombos });
            const extraRerenders = await measureRerender(harness, { samples, cpuThrottle, warmupRuns, combos: missingCombos });
            for (const m of extraMounts) measured.set(JSON.stringify(m.props), { mount: m, rerender: extraRerenders.find((r) => r.comboIndex === m.comboIndex) });
          }
        }
        matrixDeltas = [];
        for (const pair of deltaPairs) {
          const base = measured.get(JSON.stringify(pair.baseCombo));
          const flip = measured.get(JSON.stringify(pair.flipCombo));
          if (base && flip) {
            matrixDeltas.push({
              propName: pair.propName,
              baseValue: pair.baseValue,
              flipValue: pair.flipValue,
              mountDelta: flip.mount.mount.median - base.mount.mount.median,
              rerenderDelta: (flip.rerender?.stable.median ?? 0) - (base.rerender?.stable.median ?? 0),
            });
          }
        }
      }

      const matrixReport = buildMatrixReport({
        axes: matrixAxes,
        mounts: matrixMounts,
        rerenders: matrixRerenders,
        thresholds,
        flatThresholds: options.flatThresholds,
        propDeltas: matrixDeltas,
      });

      const heapDeltas = matrixMounts.map((m) => m.heapDelta ?? 0);
      const componentName = detectComponentName(metadataPath);
      const report = buildReport({
        componentPath,
        componentName,
        machine,
        calibration,
        mounts: matrixMounts,
        explores: matrixExplores,
        heapDeltas,
        thresholds,
        rerenders: matrixRerenders,
        flatThresholds: options.flatThresholds,
        skipAttribution: options.skipAttribution,
        matrixReport,
        ...(harness.nextJsShims && harness.nextJsShims.length > 0 ? { nextJsShims: harness.nextJsShims } : {}),
      });

      if (matrixDeltas) report.propDeltas = matrixDeltas;
      if (wrapper) attachWrapperReport(report, wrapper);
      attachHarnessContext(report);

      writeReportJson(report, options.jsonPath);

      return report;
    }

    const scalePoints = options.scalePoints ?? [1, 5, 20, 50];
    let zeroPropsExtracted = false;
    if (fixtureHasScale) {
      combos = scalePoints.map((n) => ({ __120fps_scaleN: n }));
    } else if (useFixture || useComposition) {
      combos = [{}];
    } else {
      schemas = await extractProps(harness.componentPath);
      zeroPropsExtracted = schemas.length === 0;
      combos = generateCombinations(schemas);
      if (combos.length === 0) combos = [{}];
      if (combos.length > 16) combos = combos.slice(0, 16);
      const scaleCombos = scalePoints.map((n) => ({ __120fps_scaleN: n }));
      combos = [...combos, ...scaleCombos];
    }

    const effectiveSamples = combos.length > 20
      ? Math.max(3, Math.min(samples, Math.floor(200 / combos.length)))
      : samples;

    const mounts = await measureMount(harness, {
      samples: effectiveSamples,
      cpuThrottle,
      warmupRuns,
      combos,
    });

    const heapDeltas: number[] = mounts.map((m) => m.heapDelta ?? 0);

    const rerenders = await measureRerender(harness, {
      samples: effectiveSamples,
      cpuThrottle,
      warmupRuns,
      combos,
    });

    const exploreCombos = combos.filter((c) => !("__120fps_scaleN" in c));
    const exploreWallClockPerCombo = exploreCombos.length > 1
      ? Math.max(10000, Math.floor(60000 / exploreCombos.length))
      : 60000;
    const explores = await explore(harness, {
      samples: Math.min(samples, 5),
      cpuThrottle,
      warmupRuns,
      seed,
      combos: exploreCombos,
      maxWallClockMs: exploreWallClockPerCombo,
    });

    let propDeltas: PropDelta[] | undefined;
    if (!useFixture && !useComposition && !options.skipDeltas && schemas && schemas.length > 0) {
      const pairs = generateDeltaPairs(schemas);
      if (pairs.length > 0) {
        const measured = new Map<string, { mount: number; rerender: number }>();
        for (const m of mounts) {
          const key = JSON.stringify(m.props);
          measured.set(key, { mount: m.mount.median, rerender: 0 });
        }
        for (const r of rerenders) {
          const key = JSON.stringify(r.props);
          const existing = measured.get(key);
          if (existing) {
            existing.rerender = r.stable.median;
          }
        }

        const needed: PropCombination[] = [];
        for (const pair of pairs) {
          for (const combo of [pair.baseCombo, pair.flipCombo]) {
            const key = JSON.stringify(combo);
            if (!measured.has(key)) {
              needed.push(combo);
              measured.set(key, { mount: 0, rerender: 0 });
            }
          }
        }

        if (needed.length > 0) {
          const extraMounts = await measureMount(harness, {
            samples: effectiveSamples,
            cpuThrottle,
            warmupRuns,
            combos: needed,
          });
          const extraRerenders = await measureRerender(harness, {
            samples: effectiveSamples,
            cpuThrottle,
            warmupRuns,
            combos: needed,
          });
          for (const m of extraMounts) {
            measured.set(JSON.stringify(m.props), { mount: m.mount.median, rerender: 0 });
          }
          for (const r of extraRerenders) {
            const key = JSON.stringify(r.props);
            const existing = measured.get(key);
            if (existing) {
              existing.rerender = r.stable.median;
            }
          }
        }

        propDeltas = pairs.map((pair) => {
          const baseKey = JSON.stringify(pair.baseCombo);
          const flipKey = JSON.stringify(pair.flipCombo);
          const base = measured.get(baseKey) ?? { mount: 0, rerender: 0 };
          const flip = measured.get(flipKey) ?? { mount: 0, rerender: 0 };
          return {
            propName: pair.propName,
            baseValue: pair.baseValue,
            flipValue: pair.flipValue,
            mountDelta: flip.mount - base.mount,
            rerenderDelta: flip.rerender - base.rerender,
          };
        });
        propDeltas.sort((a, b) => Math.abs(b.mountDelta) - Math.abs(a.mountDelta));
      }
    }

    const componentName = detectComponentName(metadataPath);

    const explicitThresholds: Partial<Record<keyof TierBudget, boolean>> = {};
    if (options.thresholds?.mountMs !== undefined) explicitThresholds.mountMs = true;
    if (options.thresholds?.rerenderMs !== undefined) explicitThresholds.rerenderMs = true;
    if (options.thresholds?.interactionMs !== undefined) explicitThresholds.interactionMs = true;

    const report = buildReport({
      componentPath,
      componentName,
      machine,
      calibration,
      mounts,
      explores,
      heapDeltas,
      thresholds,
      rerenders,
      flatThresholds: options.flatThresholds,
      explicitThresholds,
      skipAttribution: options.skipAttribution,
      ...(useFixture
        ? {
            fixturePath: inputIsFixture ? componentPath : fixturePath,
            fixtureAutoDetected,
          }
        : {}),
      ...(useComposition
        ? {
            autoComposition: true,
            compositionTree: compositionTree!,
          }
        : {}),
      nextJsShims: harness.nextJsShims,
    });

    if (zeroPropsExtracted) {
      report.warnings = [...(report.warnings ?? []), ZERO_PROPS_WARNING];
    }

    if (wrapper) attachWrapperReport(report, wrapper);
    attachHarnessContext(report);

    if (propDeltas) {
      report.propDeltas = propDeltas;
    }

    let autoScalingMatch: ScalingPropMatch | undefined;
    if (!fixtureHasScale && !useFixture && !useComposition && !options.skipAutoScale && schemas && schemas.length > 0) {
      const matches = detectScalingProps(schemas);
      if (matches.length > 0) {
        autoScalingMatch = matches[0];
        const scalePoints = options.scalePoints ?? [1, 5, 20, 50];
        const scaleCombos = generateScalingCombos(schemas, autoScalingMatch, scalePoints);

        const scaleMounts = await measureMount(harness, {
          samples,
          cpuThrottle,
          warmupRuns,
          combos: scaleCombos,
        });
        const scaleRerenders = await measureRerender(harness, {
          samples,
          cpuThrottle,
          warmupRuns,
          combos: scaleCombos,
        });

        const mountPoints = scaleMounts.map((m) => ({
          n: scalePoints[m.comboIndex],
          metric: m.mount.median,
        }));
        const rerenderPoints = scaleRerenders.map((r) => ({
          n: scalePoints[r.comboIndex],
          metric: r.stable.median,
        }));

        if (mountPoints.length >= 2) {
          const curve = computeScalingCurve(mountPoints);
          for (const combo of report.combos) {
            combo.scalingCurve = curve;
          }
        }
        if (rerenderPoints.length >= 2) {
          const rerenderCurve = computeScalingCurve(rerenderPoints);
          for (const combo of report.combos) {
            combo.rerenderScalingCurve = rerenderCurve;
          }
        }

        report.autoScalingProp = autoScalingMatch.schema.name;
        report.autoScalingReason = autoScalingMatch.reason;
      }
    }

    // --- React optimization detection (separate pass) ---
    const frameworkMode = options.framework ?? "auto";
    const effectiveFramework = resolveFramework(frameworkMode, projectRoot);

    const shouldRunReact =
      !options.skipReactAnalysis && effectiveFramework === "react";

    if (shouldRunReact) {
      const fnPropNames = schemas
        ? schemas.filter((s) => s.kind === "function").map((s) => s.name)
        : [];

      const reactResults = await runReactAnalysis(harness, {
        combos,
        samples: Math.min(samples, 3),
        cpuThrottle,
        warmupRuns: 1,
        fnPropNames,
      });

      for (const combo of report.combos) {
        const opts = reactResults.get(combo.comboIndex);
        if (opts) {
          combo.reactOptimizations = opts;
          if (combo.verdict === "pass" && hasReactWarning(opts)) {
            combo.verdict = "warn";
          }
        }
      }
    }

    const envPolicy: BaselineEnvPolicy = options.baselineEnv ?? "normalize";
    const currentEnv = buildEnvFingerprint({
      machine,
      calibration,
      cpuThrottle,
      samples,
      mode: "combo",
      ...(cssReport ? { css: cssReport.files } : {}),
      ...(wrapper ? { wrapper: wrapper.path } : {}),
      ...(harness.reactCompiler?.active ? { reactCompiler: true } : {}),
    });

    const primary = report.combos[0];
    let comboMetrics: BaselineMetrics | undefined;
    if (primary) {
      const unstable = new Set<string>();
      if (primary.mount?.unstable) unstable.add("mount");
      if (primary.rerender?.unstable) unstable.add("rerender");
      if (primary.unmount?.unstable) unstable.add("unmount");

      const interactions: Record<string, number> = {};
      for (const ix of primary.interactions) {
        interactions[ix.label] = ix.timing.median;
      }

      comboMetrics = {
        mount: primary.mount.median,
        rerender: primary.rerender.median,
        unmount: primary.unmount.median,
        domNodeCount: primary.domNodeCount,
        interactions,
        unstable,
        tier: (primary.tier ?? "T1") as BaselineEntry["tier"],
      };
    }

    applyBaselineWorkflow(report, comboMetrics, {
      options,
      projectRoot,
      relativeComponent,
      componentDir: path.dirname(resolvedPath),
      currentEnv,
      envPolicy,
    });

    writeReportJson(report, options.jsonPath);

    return report;
  } finally {
    if (browser) await browser.close();
    if (harness) await harness.cleanup();
  }
}

export const ZERO_PROPS_WARNING =
  "No props extracted — component measured with empty props only; if the component has typed props, extraction may have failed";

// --no-css wins over an explicit --css, matching --no-wrap/--wrap. Explicit
// paths resolve against process.cwd() and suppress detection; detection returns
// at most one file.
export function resolveCssFiles(
  options: Pick<AnalyzeOptions, "cssFiles" | "noCss">,
  projectRoot: string,
): { files: string[]; autoDetected: boolean } {
  if (options.noCss) return { files: [], autoDetected: false };

  if (options.cssFiles && options.cssFiles.length > 0) {
    const files: string[] = [];
    for (const raw of options.cssFiles) {
      const resolved = path.resolve(raw);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(resolved);
      } catch {
        throw new Error(`Stylesheet not found: ${raw}`);
      }
      if (!stat.isFile()) throw new Error(`Stylesheet is not a file: ${raw}`);
      if (!files.includes(resolved)) files.push(resolved);
    }
    return { files, autoDetected: false };
  }

  const detected = detectGlobalCss(projectRoot);
  return detected ? { files: [detected], autoDetected: true } : { files: [], autoDetected: false };
}

// --no-wrap wins over an explicit --wrap, matching --no-isolate/--isolate.
export function resolveWrapPath(
  options: Pick<AnalyzeOptions, "wrapPath" | "noWrap">,
  projectRoot: string,
): { wrapPath?: string; wrapAutoDetected: boolean } {
  if (options.noWrap) return { wrapAutoDetected: false };
  if (options.wrapPath) {
    const resolved = path.resolve(options.wrapPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Wrapper module not found: ${options.wrapPath}`);
    }
    return { wrapPath: resolved, wrapAutoDetected: false };
  }
  const detected = detectWrapper(projectRoot);
  return detected ? { wrapPath: detected, wrapAutoDetected: true } : { wrapAutoDetected: false };
}

// Root for 120fps.config.json / 120fps-baseline.json: nearest ancestor of the
// component containing package.json, falling back to the component's directory.
export function resolveProjectPaths(resolvedPath: string): {
  projectRoot: string;
  relativeComponent: string;
} {
  const componentDir = path.dirname(resolvedPath);
  const projectRoot = findProjectRoot(componentDir) ?? componentDir;
  const relativeComponent =
    "./" + path.relative(projectRoot, resolvedPath).replace(/\\/g, "/");
  return { projectRoot, relativeComponent };
}

export function legacyBaselineWarning(
  projectRoot: string,
  componentDir: string,
): string | undefined {
  if (componentDir === projectRoot) return undefined;
  if (!fs.existsSync(path.join(componentDir, "120fps-baseline.json"))) return undefined;
  return (
    `no baseline entry found at ${path.join(projectRoot, "120fps-baseline.json")}, ` +
    `but a legacy 120fps-baseline.json exists next to the component in ${componentDir}. ` +
    `Baselines now live at the package root — re-run with --save-baseline to migrate.`
  );
}

// Explicit --framework react|vanilla skips detection; auto detects from the
// project's package.json.
export function resolveFramework(
  mode: "react" | "vanilla" | "auto",
  projectRoot: string,
): "react" | "vanilla" {
  return mode === "auto" ? detectFramework(projectRoot) : mode;
}

export function hasScaleExport(source: string): boolean {
  return /export\s+(?:function|const)\s+scale\b/.test(source);
}

export function isFixturePath(filePath: string): boolean {
  return /\.fixture\.[jt]sx?$/.test(filePath);
}

export function detectFixture(componentPath: string): string | undefined {
  const ext = path.extname(componentPath);
  const stem = componentPath.slice(0, -ext.length);
  for (const candidate of [`${stem}.fixture.tsx`, `${stem}.fixture.ts`]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function mapReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries(value);
  }
  return value;
}
