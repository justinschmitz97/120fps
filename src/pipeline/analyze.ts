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
import { createCalibrationTrace } from "../analysis/index.js";
import { detectFixture, initFixtureOutcome, isFixturePath } from "./fixtures.js";
import { resolveCurveMatch, runCurveMode } from "./modes/curve.js";
import { runComboMode } from "./modes/combo.js";
import { runIsolationMode } from "./modes/isolation.js";
import { suppressHonoredPluginNote } from "./remedies.js";

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
  // M37: share pooled browsers across runs (the CLI passes one pool for a
  // whole multi-component sweep). analyze() creates and closes its own pool
  // when none is provided.
  browserPool?: BrowserPool;
  // M38: share one dev server per config tuple across a sweep. analyze()
  // never creates or closes one: single-component runs gain nothing.
  serverPool?: import("../harness/index.js").ServerPool;
  // M39: force measurement even when a fingerprinted baseline would allow
  // reusing the stored verdict.
  noCache?: boolean;
  // M42: attempt the run even when the graph reaches a server boundary.
  noPreflight?: boolean;
  // M48: skip the project's own Vite transforms.
  noTransforms?: boolean;
  // M65: the export to import and bind props to (`<file>#Export`). Absent, the
  // M58/M65 selection order picks one.
  target?: string;
  // M65: one line per pipeline phase boundary. Defaulted by the CLI to stdout,
  // silenced entirely in CI mode.
  onProgress?: (line: string) => void;
  // Review A2 (Lane A's run watchdog): the same phase boundaries as a signal,
  // not as console output. `onProgress` is silenced by `--ci` because `--ci`
  // owns stdout for JSON; a watchdog that re-arms per phase must not be
  // silenced with it, or a CI run degrades to a single total-budget abort with
  // no idea which phase hung. Invoked before the `ci` short-circuit and never
  // written to any stream.
  onPhase?: (phase: string) => void;
  // Item A (M90 follow-up): mirrors every warning this run discovers (the
  // `Stylesheets:` decision line, then each `runWarnings` entry as it is
  // pushed) out to a caller-supplied sink in real time, not only at the end
  // -- so a caller that also owns a *different* failure-arrival surface
  // (cli.ts's process-level `unhandledRejection` handler, which runs on a
  // separate call stack with no access to this function's own locals) can
  // still disclose everything discovered before whatever crashed it.
  onWarning?: (warning: string) => void;
}

// M65: `--ci` owns stdout for JSON (M22), so it wins over an explicit sink.
export function resolveProgressReporter(
  options: Pick<AnalyzeOptions, "ci" | "onProgress" | "onPhase">,
  write: (chunk: string) => void = (chunk) => process.stdout.write(chunk),
  // M115 C4: the run clock. Every boundary is charged here, on the one path
  // every label already travels, so a phase is measured once and `onPhase` and
  // `onProgress` see the identical stamped string.
  clock?: PhaseClock,
): (line: string) => void {
  // Review A2: every phase boundary reaches `onPhase` on every path, `--ci`
  // included. Console reporting is decided after that, not instead of it.
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

// M79 (1b): generalizes the old transformHits-only special case. Every
// warning already computed by the time of a throw is worth as much on the
// way out as it would have been in a successful report — a
// preprocessor-config-ignored or unsupported-style-engine warning explains a
// crash the bare error message alone would not. Module-level (not a closure
// inside analyze()) so M91's explainProps can reuse the identical format for
// its own dry-run parity fix. Exported (Item A, M90 follow-up) so cli.ts's
// surface-3 (async unhandledRejection) handler can build the identical
// block from the warnings it independently accumulated via
// AnalyzeOptions.onWarning, instead of duplicating the wording.
// M100 (element-plus, V4 secondary #1): a header with nothing under it told
// the reader warnings had been withheld. An empty list contributes nothing.
export function formatAccumulatedWarnings(warnings: string[]): string {
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

  // Under tiered budgets a threshold the user typed must override the tier's,
  // so every mode that builds combos needs to know which ones were explicit.
  const explicitThresholds: Partial<Record<keyof TierBudget, boolean>> = {};
  if (options.thresholds?.mountMs !== undefined) explicitThresholds.mountMs = true;
  if (options.thresholds?.rerenderMs !== undefined) explicitThresholds.rerenderMs = true;
  if (options.thresholds?.interactionMs !== undefined) explicitThresholds.interactionMs = true;

  const samples = options.samples ?? 10;
  const cpuThrottle = options.cpuThrottle ?? 4;
  const warmupRuns = options.warmupRuns ?? 2;
  const seed = options.seed ?? 42;

  // M37: every browser-using pass draws from one pool (two processes for the
  // whole run); a CLI-provided pool outlives this run and is not closed here.
  const pool = options.browserPool ?? createBrowserPool();
  const ownsPool = options.browserPool === undefined;

  // M115 C1: the run clock opens before anything is read from disk, so the
  // interval that precedes the first `preflight:` boundary is charged rather
  // than lost. Every stamp is taken at a phase boundary, never inside a traced
  // window.
  const phaseClock = createPhaseClock();
  const progress = resolveProgressReporter(options, undefined, phaseClock);

  let fixturePath: string | undefined = options.fixturePath;
  let fixtureAutoDetected = false;
  const inputIsFixture = isFixturePath(componentPath);

  // M65: `<file>#Export` names one export to render, so a fixture: which owns
  // its whole scene: cannot also apply. Validated here, before any harness
  // directory exists, so a typo costs a source read rather than a boot.
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

  // M57: one component per SFC, so there is nothing for the suffix taxonomy to
  // infer: auto-composition is skipped for Vue, not adapted to it. Reached
  // only when no fixture applies, so the measured file is componentPath.
  const rendererIsVue = isVueFile(componentPath);

  let compositionTree: CompositionTree | undefined;
  let componentExports: import("../props/index.js").ExportInfo[] | undefined;
  // M80: set when a run's combos measured less than the whole component
  // (radix's dual-family/bare-alias shape, base-ui's cross-file parts, or
  // Vue's Options-API prop exclusion). Held locally until `runWarnings`
  // exists (it is declared further down this function) because the check
  // below can fire before that point.
  let disclosureReason: "uncomposed" | "propsExcluded" | undefined;
  let uncomposedWarning: string | undefined;
  // M112 C3: what `--init-fixture` did on the never-composed path, folded into
  // the run's warnings below beside the disclosure that recommended it.
  let uncomposedFixtureLine: string | undefined;
  // M65: an explicit target names the one export to render, which is the
  // opposite of inferring a scene from several.
  if (!fixturePath && !inputIsFixture && !options.skipAutoCompose && !rendererIsVue && !options.target) {
    componentExports = await extractExports(resolvedPath);
    if (componentExports.length > 1) {
      const allSchemas = await extractAllProps(resolvedPath);
      const tree = inferComposition(componentExports, allSchemas);
      if (tree) compositionTree = tree;
    }
    // M80: composition either never attempted (a single-export file, e.g.
    // base-ui's TabsRoot.tsx) or attempted and failed to find a root (radix's
    // dual prefixed/bare-alias shape defeats findRoot's prefix check). Either
    // way the run is about to measure the bare export alone; check whether
    // the file itself still declares recognized sibling parts.
    if (!compositionTree) {
      const boundName = detectComponentExport(resolvedPath, options.target).name;
      const typeImportNames = await extractRelativeTypeImports(resolvedPath);
      const siblingExports = componentExports.filter((e) => e.name !== boundName);
      const siblings = declaredCompositionSiblings(boundName, siblingExports, typeImportNames);
      if (siblings.length > 0) {
        disclosureReason = "uncomposed";
        uncomposedWarning = UNCOMPOSED_SIBLINGS_WARNING(boundName, siblings.map((s) => s.name));
        // M112 C3 (radix-themes-F3): the flag was accepted on the one path
        // whose warning recommends it and wrote nothing. There is no inferred
        // tree here, so the scaffold is the bound root plus a placeholder per
        // declared sibling; either way the run says what the flag did.
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

  // M65: provider-dependent imports found by the preflight walk.
  let providerCandidates: string[] = [];
  // M92 gap 3: the subset of providerCandidates reached only transitively --
  // see isDirectProviderHit (src/preflight.ts) and report.ts's own comment.
  let transitiveProviderCandidates: string[] = [];
  // M48: kept outside the try so a failure on the way out can still name them.
  let transformHits: import("../project/index.js").PreflightHit[] = [];
  let activeTransforms: string[] | undefined;
  // M117 C4: applied to every harness build, so a rebuilt harness cannot bring
  // back a note about a plugin this run applies itself.
  const withoutHonoredPlugins = (list: string[]): string[] =>
    suppressHonoredPluginNote(list, projectRoot, options.noTransforms ? { noTransforms: true } : {});
  const runWarnings: string[] = [
    ...resolutionWarnings,
    ...(uncomposedWarning ? [uncomposedWarning] : []),
    ...(uncomposedFixtureLine ? [uncomposedFixtureLine] : []),
    ...(presetShapeWarning ? [presetShapeWarning] : []),
  ];
  // M46: counted before dedup: one surviving reload is a noise signal, and the
  // warning list deliberately shows it once however often it happened.
  let contextRetries = 0;
  let noiseProbe: number[] = [];
  const onWarning = (warning: string): void => {
    if (warning === CONTEXT_RETRY_WARNING) contextRetries++;
    // Deduped: a reload during a 27-combo run would otherwise print 27 times.
    if (!runWarnings.includes(warning)) {
      runWarnings.push(warning);
      // M90/Item A: mirrors the warning out to a caller-supplied sink as it
      // is discovered, not only at the end -- a fire-and-forget async
      // rejection (surface 3, cli.ts's unhandledRejection handler) can crash
      // this run's promise chain from outside this closure entirely, after
      // this point has already run but before this function ever returns
      // (or throws) normally. That handler has no other way to see anything
      // accumulated here: it runs on a separate call stack with no access to
      // this closure's locals.
      options.onWarning?.(warning);
    }
  };

  // Preset values replace a prop's pool everywhere schemas are read, so combos,
  // deltas, matrix cells and curve anchors all measure the same data.
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

    // M57: the project's own SFC parser, loaded once. A `.vue` target without
    // it cannot be read at all, so the run fails here naming the missing
    // dependency rather than deep inside Vite minutes later.
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

    // M35: calibration, trial mount, and wrapper overhead run under the same
    // driven frame pacing as the measurement passes they normalize.
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

    // One rebuild: the harness this run measures on is torn down, the new one
    // takes its place, and its build warnings join the run's.
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
      });
      // M79 gap 3b: races readiness against a fatal page error (a
      // synchronous throw during module evaluation, e.g. a next.config.mjs
      // env-validation failure) instead of always waiting out the full
      // timeout.
      await waitForReadyOrFatal(
        () =>
          page.waitForFunction(
            () => typeof (window as any).__120fps === "object",
            undefined,
            { timeout: 30000 },
          ),
        pageErrors,
        "component harness",
        () => {
          const projectRoot = path.dirname(harness!.harnessDir);
          return hasAnyEnvFile(projectRoot) ? undefined : NO_ENV_FILE_REMEDY_NOTE;
        },
      );

      await applyWrapperViewport(page);
      // M74 (B10): threads both the settle-timeout warning and, when a
      // @font-face 404'd or failed to decode, the failed-family warning
      // through the same sink every other settleStyles call site uses.
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

    // A structurally inferred tree can violate a library's nesting rules and
    // mount to an empty root. Measuring that produces confident numbers about
    // a scene nobody wrote, so prove it renders before trusting it.
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

    // M46: unthrottled and outside every traced window: the question is what
    // the machine is doing, not what the component costs.
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
        path: path.relative(projectRoot, wrapPath).replace(/\\/g, "/"),
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
      // M80 scope 2 (cross-boundary fix, see Lane G report): a plain
      // value-spread here would snapshot `disclosureReason` at ctx
      // construction time, which is always before getSchemas() -- and thus
      // extractSchemas's own, later "propsExcluded" assignment -- ever runs.
      // A getter re-reads the outer binding live, so a Vue run's disclosure
      // (computed lazily, on first getSchemas() call) still reaches
      // BuildReportInput.disclosureReason below. The "uncomposed" producer is
      // unaffected: it already assigns before this object is constructed.
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

    // --- Isolation mode ---
    if (options.isolation) {
      progress(`mode: isolation (${options.isolation.phases.join(",")})`);
      return await runIsolationMode(ctx, options.isolation);
    }

    // --- Curve mode check ---
    const curveMatch = await resolveCurveMatch(ctx);
    if (curveMatch) {
      // M83 #4a (twenty-F6): the CLI already rejects an explicit --curve
      // combined with an explicit --matrix at parse time, so a truthy
      // curveMatch here alongside an explicit --matrix can only be an
      // auto-activation winning a mode conflict the user did not ask to lose
      // silently.
      if (options.matrixMode === true) {
        runWarnings.push(MATRIX_SUPPRESSED_BY_CURVE_WARNING(curveMatch.schema.name));
      }
      progress(`mode: curve on ${curveMatch.schema.name}`);
      return await runCurveMode(ctx, curveMatch);
    }

    // --- Matrix mode check ---
    const matrixEligible = options.matrixMode !== false && !useFixture && !composed;
    const matrixRequested = options.matrixMode === true;
    // Distinct from a forced --matrix: only auto-activation is a surprise
    // worth an upfront notice, since --matrix was the user's own request.
    const matrixAutoActivates =
      matrixEligible && !matrixRequested && shouldAutoActivateMatrix(await ctx.getSchemas());
    // M100 (element-plus-F4): one predicate, shared with the dry run's own
    // prediction, so the two can no longer disagree about which mode a run
    // takes. Curve has already returned above; passing `curve: false` here
    // states that fact rather than leaving it implicit in the control flow.
    const activateMatrix =
      predictMode({
        isolation: false,
        curve: false,
        matrixEligible,
        matrixRequested,
        matrixAutoActivates,
      }) === "matrix";
    const matrixAutoActivated = activateMatrix && matrixAutoActivates;
    // M110 C3 (calcom-R1): the curve branch above has named its winner since
    // M83; these two dropped an explicit --matrix in silence. A composed scene
    // and a fixture are mutually exclusive here (composition is skipped
    // whenever a fixture applies), so at most one line is pushed.
    if (matrixRequested && !activateMatrix) {
      if (composed) {
        runWarnings.push(MATRIX_SUPPRESSED_BY_COMPOSITION_WARNING(compositionTree!.root));
      } else if (useFixture) {
        runWarnings.push(
          MATRIX_SUPPRESSED_BY_FIXTURE_WARNING(
            path.relative(projectRoot, path.resolve(fixturePath!)).replace(/\\/g, "/"),
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
    // M79/M78: a preflight hard-rejection already names a complete, correct
    // fix (nothing was built yet); stacking accumulated warnings on top of it
    // is exactly the compounding-note bug (excalidraw-F3's "needs a CSS
    // preprocessor" note glued onto an unrelated "nothing installed" hard
    // rejection).
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

// M65: `<file>#Export` and `--fixture` both decide what gets rendered.
export const TARGET_WITH_FIXTURE_ERROR =
  "A named export target (<file>#Export) cannot be combined with --fixture: a fixture already decides what renders";

function mapReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries(value);
  }
  return value;
}
