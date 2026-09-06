import fs from "node:fs";
import path from "node:path";
import {
  type BaselineEnvPolicy,
  type CalibrationResult,
  DEFAULT_THRESHOLDS,
  type PhaseClock,
  type Report,
  type Thresholds,
  type TierBudget,
  type WrapperReport,
  createPhaseClock,
  deriveReportMode,
  formatElapsedClock,
} from "../report/index.js";
import {
  type BrowserPool,
  CONTEXT_RETRY_WARNING,
  HARNESS_NAV_WAIT,
  type MeasurementSession,
  applyWrapperViewport,
  createBrowserPool,
  gotoWithErrorContext,
  harnessReadyTimeoutMs,
  measureWrapperOverhead,
  openMeasurementSession,
  probeMachineNoise,
  reportFontSettle,
  settleStyles,
  suspendThrottle,
  waitForReadyOrFatal,
} from "../browser/index.js";
import {
  type BuildHarnessOptions,
  type HarnessResult,
  NO_ENV_FILE_REMEDY_NOTE,
  buildAndServe,
  detectComponentExport,
  detectScaleExport,
  hasAnyEnvFile,
} from "../harness/index.js";
import {
  type CompositionTree,
  type ExportInfo,
  type PropSchema,
  UNCOMPOSED_SIBLINGS_WARNING,
  declaredCompositionSiblings,
  extractAllProps,
  extractExports,
  extractRelativeTypeImports,
  inferComposition,
  shouldAutoActivateMatrix,
} from "../props/index.js";
import {
  MATRIX_SUPPRESSED_BY_COMPOSITION_WARNING,
  MATRIX_SUPPRESSED_BY_CURVE_WARNING,
  MATRIX_SUPPRESSED_BY_FIXTURE_WARNING,
  runMatrixMode,
} from "./modes/matrix.js";
import { type ModeContext, predictMode } from "./modes/context.js";
import {
  PreflightHardRejectionError,
  type PreflightHit,
  VUE_COMPILER_MISSING,
  isVueFile,
  loadVueCompiler,
} from "../project/index.js";
import {
  classifyHarnessFault,
  createHarnessContextAttacher,
  createSchemaExtractor,
  createSourceFingerprint,
  prepareRunInputs,
  recordStylesheetMatches,
  recoverFromUnreadableStylesheet,
  rollbackEmptyComposition,
  runPreflightPhase,
} from "./phases.js";
import { collectMachineInfo, tryReuseStoredVerdict } from "./verdict-reuse.js";
import { createCalibrationTrace } from "../report/index.js";
import { detectFixture, initFixtureOutcome, isFixturePath } from "./fixtures.js";
import { resolveCurveMatch, runCurveMode } from "./modes/curve.js";
import { runComboMode } from "./modes/combo.js";
import { runIsolationMode } from "./modes/isolation.js";
import { suppressHonoredPluginNote } from "./remedies.js";
import { toPosix } from "../shared/index.js";

export {
  runPreflight,
  preflightFailureMessage,
  transformFailureNote,
  recognizeTransform,
  NODE_BUILTIN_WARNING,
  PROJECT_TRANSFORM_WARNING,
  PREFLIGHT_BYPASSED_WARNING,
  TRANSFORM_RECOGNIZERS,
} from "../project/index.js";

export interface AnalyzeOptions {
  samples?: number;
  maxCombos?: number;
  initFixture?: boolean;
  exploreBudgetMs?: number;
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
  framework?: "react" | "vue" | "vanilla" | "auto";
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
  // Shared across a sweep; analyze() creates and closes its own pool when none is given.
  browserPool?: BrowserPool;
  // Shared across a sweep; analyze() never creates or closes one, as one run gains nothing.
  serverPool?: import("../harness/index.js").ServerPool;
  // Measure even when a fingerprinted baseline would allow reusing the stored verdict.
  noCache?: boolean;
  // Attempt the run even when the graph reaches a server boundary.
  noPreflight?: boolean;
  // Skip the project's own Vite transforms.
  noTransforms?: boolean;
  // The export to import and bind props to (`<file>#Export`); absent, the resolver picks one.
  target?: string;
  // One line per phase boundary, defaulted by the CLI to stdout and silenced in CI mode.
  onProgress?: (line: string) => void;
  // A watchdog signal, never a stream: --ci silences onProgress, a per-phase re-arm must survive.
  onPhase?: (phase: string) => void;
  // Mirrored in real time, so a caller owning a separate failure surface still sees them.
  onWarning?: (warning: string) => void;
}

// `--ci` owns stdout for JSON, so it wins over an explicit sink.
export function resolveProgressReporter(
  options: Pick<AnalyzeOptions, "ci" | "onProgress" | "onPhase">,
  write: (chunk: string) => void = (chunk) => process.stdout.write(chunk),
  // Charged on the one path every label travels, so a phase is measured once.
  clock?: PhaseClock,
): (line: string) => void {
  // Every boundary reaches onPhase on every path, --ci included; console output is decided after.
  const heartbeat = options.onPhase;
  const stamp = (line: string): string =>
    clock ? `${line}  (${formatElapsedClock(clock.boundary(line))})` : line;
  if (options.ci) {
    return (line) => {
      heartbeat?.(stamp(line));
    };
  }
  const sink = options.onProgress;
  if (sink) {
    return (line) => {
      const stamped = stamp(line);
      heartbeat?.(stamped);
      sink(stamped);
    };
  }
  return (line) => {
    const stamped = stamp(line);
    heartbeat?.(stamped);
    write(stamped + "\n");
  };
}

export function writeReportJson(report: Report, jsonPath: string | undefined): void {
  report.mode = deriveReportMode(report);
  const target = path.resolve(jsonPath ?? "120fps-report.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(report, mapReplacer, 2), "utf-8");
}

// One wording for every failure surface: the dry run and cli/main.ts's async handler reuse it.
export function formatAccumulatedWarnings(warnings: string[]): string {
  // A header with nothing under it would tell the reader warnings had been withheld.
  if (warnings.length === 0) return "";
  return ["", "", "Warnings recorded before this failure:", ...warnings.map((w) => `  ${w}`)].join("\n");
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

  // A threshold the user typed overrides the tier's, so every mode must know which were explicit.
  const explicitThresholds: Partial<Record<keyof TierBudget, boolean>> = {};
  if (options.thresholds?.mountMs !== undefined) explicitThresholds.mountMs = true;
  if (options.thresholds?.rerenderMs !== undefined) explicitThresholds.rerenderMs = true;
  if (options.thresholds?.interactionMs !== undefined) explicitThresholds.interactionMs = true;

  const samples = options.samples ?? 10;
  const cpuThrottle = options.cpuThrottle ?? 4;
  const warmupRuns = options.warmupRuns ?? 2;
  const seed = options.seed ?? 42;

  // A CLI-provided pool outlives this run and is not closed here.
  const pool = options.browserPool ?? createBrowserPool();
  const ownsPool = options.browserPool === undefined;

  // Opened before the first disk read, so the interval preceding preflight is charged, not lost.
  const phaseClock = createPhaseClock();
  const progress = resolveProgressReporter(options, undefined, phaseClock);

  let fixturePath: string | undefined = options.fixturePath;
  let fixtureAutoDetected = false;
  const inputIsFixture = isFixturePath(componentPath);

  // Validated before any harness directory exists, so a typo costs a source read, not a boot.
  if (options.target) {
    if (options.fixturePath || inputIsFixture) throw new Error(TARGET_WITH_FIXTURE_ERROR);
    detectComponentExport(resolvedPath, options.target);
  }

  if (inputIsFixture) {
    fixturePath = componentPath;
  } else if (!fixturePath && !options.target) {
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

  // One component per SFC leaves the suffix taxonomy nothing to infer, so Vue skips composition.
  const rendererIsVue = isVueFile(componentPath);

  let compositionTree: CompositionTree | undefined;
  let componentExports: import("../props/index.js").ExportInfo[] | undefined;
  // Held locally because the check below can fire before runWarnings is declared.
  let disclosureReason: "uncomposed" | "propsExcluded" | undefined;
  let uncomposedWarning: string | undefined;
  // What --init-fixture did, folded in below beside the disclosure that recommended it.
  let uncomposedFixtureLine: string | undefined;
  // An explicit target names one export to render, the opposite of inferring a scene from several.
  if (!fixturePath && !inputIsFixture && !options.skipAutoCompose && !rendererIsVue && !options.target) {
    componentExports = await extractExports(resolvedPath);
    if (componentExports.length > 1) {
      const allSchemas = await extractAllProps(resolvedPath);
      const tree = inferComposition(componentExports, allSchemas);
      if (tree) compositionTree = tree;
    }
    // The run is about to measure the bare export alone; the file may still declare sibling parts.
    if (!compositionTree) {
      const boundName = detectComponentExport(resolvedPath, options.target).name;
      const typeImportNames = await extractRelativeTypeImports(resolvedPath);
      const siblingExports = componentExports.filter((e) => e.name !== boundName);
      const siblings = declaredCompositionSiblings(boundName, siblingExports, typeImportNames);
      if (siblings.length > 0) {
        disclosureReason = "uncomposed";
        uncomposedWarning = UNCOMPOSED_SIBLINGS_WARNING(boundName, siblings.map((s) => s.name));
        // No inferred tree here, so the scaffold is the bound root plus a placeholder per sibling.
        if (options.initFixture) {
          uncomposedFixtureLine = initFixtureOutcome(
            resolvedPath,
            boundName,
            siblings.map((s) => s.name),
            componentExports,
          );
        }
      }
    }
  }

  const useFixture = fixturePath !== undefined;
  const useComposition = compositionTree !== undefined;
  const harnessPath = useFixture ? fixturePath! : componentPath;
  const metadataPath = inputIsFixture ? componentPath : resolvedPath;

  const {
    projectRoot,
    relativeComponent,
    resolutionWarnings,
    framework,
    wrapPath,
    wrapAutoDetected,
    resolvedCss,
    cssReport,
    cssDecisionWarning,
    presets,
    presetShapeWarning,
    presetSuppliedProps,
  } = prepareRunInputs({ options, resolvedPath, harnessPath, useFixture });

  // Provider-dependent imports found by the preflight walk.
  let providerCandidates: string[] = [];
  // The subset reached only transitively; see isDirectProviderHit (project/preflight.ts).
  let transitiveProviderCandidates: string[] = [];
  // Declared before the try so attachHarnessContext can read them after the harness phase.
  let transformHits: import("../project/index.js").PreflightHit[] = [];
  let activeTransforms: string[] | undefined;
  // Applied to every build, so a rebuilt harness cannot revive a note about an applied plugin.
  const withoutHonoredPlugins = (list: string[]): string[] =>
    suppressHonoredPluginNote(list, projectRoot, options.noTransforms ? { noTransforms: true } : {});
  const runWarnings: string[] = [
    ...resolutionWarnings,
    ...(uncomposedWarning ? [uncomposedWarning] : []),
    ...(uncomposedFixtureLine ? [uncomposedFixtureLine] : []),
    ...(presetShapeWarning ? [presetShapeWarning] : []),
  ];
  // Counted before dedup: the reload count is a noise signal, though the warning prints once.
  let contextRetries = 0;
  let noiseProbe: number[] = [];
  const onWarning = (warning: string): void => {
    if (warning === CONTEXT_RETRY_WARNING) contextRetries++;
    // Deduped: a reload during a 27-combo run would otherwise print 27 times.
    if (!runWarnings.includes(warning)) {
      runWarnings.push(warning);
      // Mirrored as discovered: a detached rejection can crash the run without reaching any catch.
      options.onWarning?.(warning);
    }
  };

  // Preset values replace a prop's pool everywhere schemas are read, so every pass agrees.
  const presetApplied = new Set<string>();
  const extractSchemas = createSchemaExtractor({
    options,
    projectRoot,
    presets,
    presetSuppliedProps,
    presetApplied,
    onWarning,
    useFixture,
    getCompositionTree: () => compositionTree,
    getDisclosureReason: () => disclosureReason,
    setDisclosureReason: (reason) => {
      disclosureReason = reason;
    },
  });

  const { getSourceFingerprint, resetSourceFingerprint } = createSourceFingerprint({
    options,
    projectRoot,
    harnessPath,
    metadataPath,
    cssReport,
    resolvedCss,
    presets,
    wrapPath,
    samples,
    cpuThrottle,
  });

  const attachHarnessContext = createHarnessContextAttacher({
    runWarnings,
    cssReport,
    presets,
    presetApplied,
    state: () => ({
      providerCandidates,
      transitiveProviderCandidates,
      noiseProbe,
      contextRetries,
      activeTransforms,
      harness,
    }),
  });

  let harness: HarnessResult | undefined;
  let msession: MeasurementSession | undefined;

  try {
    const reused = await tryReuseStoredVerdict({
      options,
      pool,
      projectRoot,
      relativeComponent,
      componentPath,
      metadataPath,
      thresholds,
      samples,
      cpuThrottle,
      framework,
      ...(cssReport !== undefined ? { cssReport } : {}),
      ...(wrapPath !== undefined ? { wrapPath } : {}),
      getSourceFingerprint,
    });
    if (reused) return reused;

    // Fail here naming the missing dependency, rather than deep inside Vite minutes later.
    const vueCompiler = framework === "vue" ? await loadVueCompiler(projectRoot) : undefined;
    if (framework === "vue" && !vueCompiler && isVueFile(harnessPath)) {
      throw new Error(VUE_COMPILER_MISSING(projectRoot));
    }

    const preflightPhase = runPreflightPhase({
      options,
      projectRoot,
      harnessPath,
      framework,
      runWarnings,
      progress,
      ...(wrapPath !== undefined ? { wrapPath } : {}),
      ...(vueCompiler !== undefined ? { vueCompiler } : {}),
    });
    providerCandidates = preflightPhase.providerCandidates;
    transitiveProviderCandidates = preflightPhase.transitiveProviderCandidates;
    transformHits = preflightPhase.transformHits;
    activeTransforms = preflightPhase.activeTransforms;

    const baseHarnessOpts: import("../harness/index.js").BuildHarnessOptions = {
      ...(options.noShims ? { noShims: true } : {}),
      ...(wrapPath ? { wrapPath } : {}),
      ...(resolvedCss.files.length > 0 ? { cssFiles: resolvedCss.files } : {}),
      ...(options.reactCompiler !== undefined ? { reactCompiler: options.reactCompiler } : {}),
      ...(options.serverPool ? { serverPool: options.serverPool } : {}),
      ...(presets ? { presetPath: presets.absolutePath } : {}),
      ...(options.noTransforms ? { noTransforms: true } : {}),
      ...(options.target ? { target: options.target } : {}),
    };
    const composedHarnessOpts: import("../harness/index.js").BuildHarnessOptions = {
      ...baseHarnessOpts,
      ...(useComposition ? { composition: compositionTree!, exports: componentExports } : {}),
    };
    progress("harness: building");
    harness = await buildAndServe(harnessPath, composedHarnessOpts);
    if (harness.warnings) runWarnings.push(...withoutHonoredPlugins(harness.warnings));

    // Calibration, trial mount and wrapper overhead run under the pacing they normalize.
    msession = await openMeasurementSession({
      driven: true,
      onWarning,
      pool,
      harnessDirName: path.basename(harness.harnessDir),
    });
    const page = msession.page;
    const pageErrors = msession.errorCapture;
    const cdp = msession.session.cdp;

    const chromiumVersion = msession.browser.version();
    const machine = await collectMachineInfo(chromiumVersion);

    // The harness this run measures on is torn down, and the new one's warnings join the run's.
    const rebuildHarness = async (
      opts: import("../harness/index.js").BuildHarnessOptions,
    ): Promise<void> => {
      await harness!.cleanup();
      harness = await buildAndServe(harnessPath, opts);
      if (harness.warnings) runWarnings.push(...withoutHonoredPlugins(harness.warnings));
    };

    const enterHarnessPage = async (): Promise<void> => {
      await gotoWithErrorContext(page, harness!.url, pageErrors, "component harness", {
        waitUntil: HARNESS_NAV_WAIT,
        // The bound the readiness wait below advertises, so neither half reports another.
        timeout: harnessReadyTimeoutMs(),
      });
      // Races readiness against a fatal page error instead of waiting out the full timeout.
      await waitForReadyOrFatal(
        () =>
          page.waitForFunction(
            () => typeof (window as any).__120fps === "object",
            undefined,
            // The same bound waitForReadyOrFatal enforces, so neither wait ends before the other.
            { timeout: harnessReadyTimeoutMs() },
          ),
        pageErrors,
        "component harness",
        () => {
          const projectRoot = path.dirname(harness!.harnessDir);
          return hasAnyEnvFile(projectRoot) ? undefined : NO_ENV_FILE_REMEDY_NOTE;
        },
      );

      await applyWrapperViewport(page);
      // Settle-timeout and failed-font-family warnings reach the sink every settleStyles site uses.
      reportFontSettle(await settleStyles(page, harness!), onWarning);
    };

    try {
      await enterHarnessPage();
    } catch (err) {
      await recoverFromUnreadableStylesheet(err, {
        resolvedCss,
        cssReport,
        composedHarnessOpts,
        onWarning,
        resetSourceFingerprint,
        rebuildHarness,
        enterHarnessPage,
      });
    }

    // An inferred tree can break a library's nesting rules, so prove it renders before measuring.
    if (useComposition) {
      await rollbackEmptyComposition({
        page,
        options,
        resolvedPath,
        compositionTree: compositionTree!,
        componentExports,
        runWarnings,
        baseHarnessOpts,
        rebuildHarness,
        enterHarnessPage,
        clearComposition: () => {
          compositionTree = undefined;
          componentExports = undefined;
        },
        setDisclosureReason: () => {
          disclosureReason = "uncomposed";
        },
      });
    }
    const composed = compositionTree !== undefined;

    await recordStylesheetMatches({ page, cssReport, onWarning });

    // Unthrottled and outside every traced window: the question is the machine, not the component.
    noiseProbe = await suspendThrottle(cdp, cpuThrottle, () => probeMachineNoise(page));

    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });

    progress("calibration");
    const calibrationMetrics = await createCalibrationTrace(page, cdp);
    const calibration: CalibrationResult = {
      totalDuration: calibrationMetrics.totalDuration,
      scriptDuration: calibrationMetrics.scriptDuration,
    };

    if (calibration.totalDuration === 0) {
      throw new Error("Calibration produced zero duration: measurement environment is broken");
    }

    let wrapper: WrapperReport | undefined;
    if (wrapPath) {
      const overhead = await measureWrapperOverhead(page, cdp, samples);
      wrapper = {
        path: toPosix(path.relative(projectRoot, wrapPath)),
        autoDetected: wrapAutoDetected,
        overheadMs: overhead.overheadMs,
        domNodes: overhead.domNodes,
        ...(overhead.hasSetup ? { hasSetup: true } : {}),
      };
    }

    await msession.close();
    msession = undefined;

    let schemas: import("../props/index.js").PropSchema[] | undefined;
    const fixtureHasScale = useFixture && detectScaleExport(path.resolve(harnessPath));

    const ctx: ModeContext = {
      options,
      harness,
      pool,
      machine,
      calibration,
      thresholds,
      explicitThresholds,
      samples,
      cpuThrottle,
      warmupRuns,
      seed,
      componentPath,
      resolvedPath,
      metadataPath,
      projectRoot,
      relativeComponent,
      inputIsFixture,
      useFixture,
      framework,
      ...(fixturePath !== undefined ? { fixturePath } : {}),
      fixtureAutoDetected,
      composed,
      ...(compositionTree !== undefined ? { compositionTree } : {}),
      // A getter, not a spread: extractSchemas assigns "propsExcluded" after ctx is constructed.
      get disclosureReason() {
        return disclosureReason;
      },
      ...(wrapper !== undefined ? { wrapper } : {}),
      ...(cssReport !== undefined ? { cssReport } : {}),
      runWarnings,
      onWarning,
      progress,
      phaseClock,
      getSchemas: async () => (schemas ??= await extractSchemas(harness!.componentPath)),
      getSourceFingerprint,
      attachHarnessContext,
    };

    if (options.isolation) {
      progress(`mode: isolation (${options.isolation.phases.join(",")})`);
      return await runIsolationMode(ctx, options.isolation);
    }

    const curveMatch = await resolveCurveMatch(ctx);
    if (curveMatch) {
      // The CLI rejects explicit --curve with explicit --matrix, so this is an auto-activation.
      if (options.matrixMode === true) {
        runWarnings.push(MATRIX_SUPPRESSED_BY_CURVE_WARNING(curveMatch.schema.name));
      }
      progress(`mode: curve on ${curveMatch.schema.name}`);
      return await runCurveMode(ctx, curveMatch);
    }

    const matrixEligible = options.matrixMode !== false && !useFixture && !composed;
    const matrixRequested = options.matrixMode === true;
    // Only auto-activation is a surprise worth an upfront notice; --matrix was the user's request.
    const matrixAutoActivates =
      matrixEligible && !matrixRequested && shouldAutoActivateMatrix(await ctx.getSchemas());
    // Shared with the dry run's prediction, so the two cannot disagree about the mode taken.
    const activateMatrix =
      predictMode({
        isolation: false,
        curve: false,
        matrixEligible,
        matrixRequested,
        matrixAutoActivates,
      }) === "matrix";
    const matrixAutoActivated = activateMatrix && matrixAutoActivates;
    // A composed scene and a fixture are mutually exclusive, so at most one line is pushed.
    if (matrixRequested && !activateMatrix) {
      if (composed) {
        runWarnings.push(MATRIX_SUPPRESSED_BY_COMPOSITION_WARNING(compositionTree!.root));
      } else if (useFixture) {
        runWarnings.push(
          MATRIX_SUPPRESSED_BY_FIXTURE_WARNING(
            toPosix(path.relative(projectRoot, path.resolve(fixturePath!))),
            inputIsFixture ? "fixture-input" : fixtureAutoDetected ? "sibling" : "explicit-flag",
          ),
        );
      }
    }

    if (activateMatrix) {
      progress("mode: prop matrix");
      return await runMatrixMode(ctx, matrixAutoActivated);
    }

    progress("mode: prop combos");
    return await runComboMode(ctx, fixtureHasScale);
  } catch (err) {
    // A preflight hard-rejection already names a complete fix; accumulated notes would dilute it.
    if (err instanceof PreflightHardRejectionError) throw err;
    const { presented, combined, abortHints } = await classifyHarnessFault({
      err,
      projectRoot,
      resolvedPath,
      cssDecisionWarning,
      runWarnings,
    });
    throw new Error(presented + formatAccumulatedWarnings(combined) + abortHints, { cause: err });
  } finally {
    if (msession) await msession.close();
    if (ownsPool) await pool.closeAll();
    if (harness) await harness.cleanup();
  }
}

// `<file>#Export` and `--fixture` both decide what gets rendered.
export const TARGET_WITH_FIXTURE_ERROR =
  "A named export target (<file>#Export) cannot be combined with --fixture: a fixture already decides what renders";

function mapReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries(value);
  }
  return value;
}
