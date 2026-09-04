import fs from "node:fs";
import path from "node:path";
import {
  buildAndServe,
  detectComponentExport,
  detectProjectTransforms,
  detectScaleExport,
  detectBundlerReactDomAlias,
  BUNDLER_PREACT_ALIAS_WARNING,
  hasAnyEnvFile,
  NO_ENV_FILE_REMEDY_NOTE,
  presentBundlerFailure,
  stylesheetReadFailureTarget,
  CSS_UNREADABLE_DROPPED_WARNING,
  type HarnessResult,
} from "../harness/index.js";
import {
  gotoWithErrorContext,
  waitForReadyOrFatal,
  probeMachineNoise,
  buildNoiseReport,
  formatNoiseWarning,
  applyWrapperViewport,
  createBrowserPool,
  measureWrapperOverhead,
  openMeasurementSession,
  settleStyles,
  reportFontSettle,
  suspendThrottle,
  CONTEXT_RETRY_WARNING,
  HARNESS_NAV_WAIT,
  type BrowserPool,
  type MeasurementSession,
} from "../browser/index.js";
import {
  extractPropsDetailed,
  extractExports,
  extractAllProps,
  projectSourceFiles,
  isVuePropsScopeExclusionWarning,
  type PropSchema,
  detectPropPresets,
  loadPropPresets,
  applyPropPresets,
  UNKNOWN_PRESET_PROPS_WARNING,
  inferComposition,
  shouldRollbackComposition,
  COMPOSITION_EMPTY_WARNING,
  declaredCompositionSiblings,
  extractRelativeTypeImports,
  UNCOMPOSED_SIBLINGS_WARNING,
  type CompositionTree,
  type ExportInfo,
  shouldAutoActivateMatrix,
} from "../props/index.js";
import {
  formatMountAbortHints,
  computeSourceFingerprint,
  type BaselineEnvPolicy,
  deriveReportMode,
  DEFAULT_THRESHOLDS,
  type CalibrationResult,
  type Report,
  type TierBudget,
  type Thresholds,
  type WrapperReport,
  formatStylesheetsLine,
  createPhaseClock,
  formatElapsedClock,
  type PhaseClock,
  dedupeWarnings,
} from "../report/index.js";
import {
  runPreflight,
  preflightFailureMessage,
  providerCandidateLabels,
  providersFromEntry,
  isDirectProviderHit,
  NODE_BUILTIN_WARNING,
  PROJECT_TRANSFORM_WARNING,
  PREFLIGHT_BYPASSED_WARNING,
  PreflightHardRejectionError,
  classifyProjectTransformHits,
  isVueFile,
  loadVueCompiler,
  VUE_COMPILER_MISSING,
} from "../project/index.js";
import { createCalibrationTrace } from "../analysis/index.js";
import { buildCssReport, buildReactCompilerReport } from "./build-report.js";
import {
  composedChildPreflightHits,
  detectFixture,
  initFixtureOutcome,
  isFixturePath,
  trialMountComposition,
  writeFixtureScaffold,
} from "./fixtures.js";
import { runComboMode } from "./modes/combo.js";
import { type ModeContext, predictMode } from "./modes/context.js";
import { resolveCurveMatch, runCurveMode } from "./modes/curve.js";
import { runIsolationMode } from "./modes/isolation.js";
import {
  MATRIX_SUPPRESSED_BY_COMPOSITION_WARNING,
  MATRIX_SUPPRESSED_BY_CURVE_WARNING,
  MATRIX_SUPPRESSED_BY_FIXTURE_WARNING,
  runMatrixMode,
} from "./modes/matrix.js";
import {
  RE_EXPORT_MEASURED_DISCLOSURE,
  UNRESOLVED_RE_EXPORT_WARNING,
  alternativeExportNote,
  measuredSfcUsesInject,
  presetAnswersRemedy,
  presetShapeDisclosure,
  remedyNamesLoadedPreset,
  renderFailed,
  suppressHonoredPluginNote,
  viteConfigIgnoredKeys,
} from "./remedies.js";
import {
  STYLESHEET_MATCHED_NOTHING_WARNING,
  probeStylesheetMatchStats,
  resolveCssFiles,
  resolveFramework,
  resolveProjectPaths,
  resolveWrapPath,
} from "./resolve.js";
import { collectMachineInfo, projectConfigFingerprintFiles, tryReuseStoredVerdict } from "./verdict-reuse.js";

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

  const { projectRoot, relativeComponent } = resolveProjectPaths(resolvedPath);
  // M57: resolved before the wrapper, because a Vue project's wrapper is an SFC
  // and a `.tsx` one left lying around could not render the component at all.
  // Collected before the run's warning list exists; folded into it below.
  const frameworkWarnings: string[] = [];
  const framework = resolveFramework(options.framework ?? "auto", projectRoot, harnessPath, (w) =>
    frameworkWarnings.push(w),
  );
  // M76: what the wrapper probe had to fall back to, folded into the run's
  // warnings below alongside frameworkWarnings and cssWarnings.
  const wrapWarnings: string[] = [];
  const { wrapPath, wrapAutoDetected } = resolveWrapPath(options, projectRoot, framework, wrapWarnings);
  // M71: what discovery had to guess at, folded into the run's warnings below.
  const cssWarnings: string[] = [];
  const resolvedCss = resolveCssFiles(options, projectRoot, cssWarnings, {
    ...(wrapPath ? { wrapPath } : {}),
    measuredFile: resolvedPath,
  });
  const cssReport = buildCssReport(resolvedCss, projectRoot);
  // M90 (ant-design-F6, dub-F3, nuxt-ui-F4, mantine-F5, calcom-F6,
  // shadcn-ui-F3): computed once, right where the decision is made, so it
  // survives any later throw regardless of where in the pipeline it lands.
  // Deliberately kept out of `runWarnings`/`cssWarnings` (which become
  // `report.warnings` on a successful run): the decision already has its own
  // dedicated `Stylesheets:` line there, and folding this in too would print
  // it twice. It is threaded only into the crash-path catch below.
  const cssDecisionWarning = formatStylesheetsLine(cssReport);
  // Item A (ant-design-F5/F7/F9 follow-up): mirrored out immediately, same
  // reasoning as the internal `onWarning` closure below -- a surface-3 async
  // rejection needs this available before this function's own local catch
  // ever gets a chance to build `combined`, since that catch's stack frame
  // is exactly what a detached rejection never reaches.
  options.onWarning?.(cssDecisionWarning);
  // M44: a fixture already owns its scene, so presets never apply there.
  const presetPath = useFixture ? undefined : detectPropPresets(resolvedPath);
  const presets = presetPath ? loadPropPresets(presetPath, projectRoot) : undefined;
  // M112 C2: the same disclosure the dry run prints, from the same producer, so
  // both modes name the rejected sibling in the same words (M100 parity). A
  // fixture owns its scene, so a preset-named sibling is irrelevant there.
  const presetShapeWarning = useFixture
    ? undefined
    : presetShapeDisclosure(resolvedPath, projectRoot);
  // M112 C1: the props the preset supplies values for, known before extraction
  // runs, so the remedies it answers never reach the terminal.
  const presetSuppliedProps = presets
    ? [...presets.entries].filter(([, values]) => values.length > 0).map(([name]) => name)
    : [];

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
    ...frameworkWarnings,
    ...cssWarnings,
    ...wrapWarnings,
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
  const extractSchemas = async (file: string): Promise<PropSchema[]> => {
    // M80 scope 2: extractPropsDetailed's warnings (not just the Vue one)
    // used to be dropped on this, the real measurement path, even though
    // --explain-props's extractPropsDetailed call already passed onWarning.
    // M92 (element-plus-F3): covers both Vue scope exclusions ADR 0002
    // defines -- Options-API props and a <script setup> runtime-object
    // defineProps({...}) call -- so either one downgrades to the same
    // disclosure instead of the generic "extraction may have failed" text.
    let sawPropsScopeExclusion = false;
    const extracted = await extractPropsDetailed(file, {
      ...(options.target ? { target: options.target } : {}),
      onWarning: (warning) => {
        if (isVuePropsScopeExclusionWarning(warning)) sawPropsScopeExclusion = true;
        // M112 C1: the preset is loaded before extraction runs here, so a
        // collapsed-union remedy for a prop it supplies values for is dropped
        // as it is produced rather than printed and then contradicted. The
        // same rule the dry run applies, on the same warning texts.
        if (presetSuppliedProps.length > 0 && presetAnswersRemedy(warning, presetSuppliedProps)) {
          return;
        }
        // M112 C1: a remedy the preset did not answer survives, and names the
        // preset the run already loaded instead of asking for a file.
        onWarning(presets ? remedyNamesLoadedPreset(warning, presets.path) : warning);
      },
    });
    const raw = extracted.schemas;
    // M114 C1 (gutenberg-F2, react-spectrum-F3): the same two disclosures the
    // dry run prints, in the same words, from the same extraction record. Both
    // are decided by the filesystem, so M100's parity rule covers them.
    const asProjectPath = (target: string): string =>
      path.relative(projectRoot, target).replace(/\\/g, "/");
    if (
      extracted.targetFile !== undefined &&
      path.resolve(extracted.targetFile) !== path.resolve(file)
    ) {
      onWarning(
        RE_EXPORT_MEASURED_DISCLOSURE(asProjectPath(file), asProjectPath(extracted.targetFile)),
      );
    }
    if (extracted.unresolvedReExport) {
      onWarning(
        UNRESOLVED_RE_EXPORT_WARNING(
          asProjectPath(extracted.unresolvedReExport.barrel),
          extracted.unresolvedReExport.specifier,
        ),
      );
    }
    // The producer for BuildReportInput.disclosureReason's "propsExcluded"
    // value (M80 scope 1 built the downgrade; nothing produced this value
    // until now). `disclosureReason` is untouched by the auto-composition
    // guard above for a Vue run (rendererIsVue skips it entirely), so this is
    // the only place a Vue run can set it.
    if (raw.length === 0 && sawPropsScopeExclusion && disclosureReason === undefined) {
      disclosureReason = "propsExcluded";
    }
    const applied = presets ? applyPropPresets(raw, presets) : undefined;
    if (applied) {
      for (const name of applied.applied) presetApplied.add(name);
      if (applied.unknown.length > 0) {
        onWarning(UNKNOWN_PRESET_PROPS_WARNING(presets!.path, applied.unknown));
      }
    }
    const finalSchemas = applied ? applied.schemas : raw;
    // M100 (chakra-ui-F4): the same note --explain-props prints, from the same
    // function, on the same schemas the run will measure. A fixture owns its
    // scene, so retargeting an export inside it is not the remedy there.
    // C-10: a composed scene owns the render exactly as a fixture does, and it
    // now reaches getSchemas(), so the retarget note would print beside
    // NO_PROPS_MEASURED_WARNING and contradict it -- advising a retarget
    // because of a required degenerate prop the run never applied.
    // Read live, not captured: this closure runs lazily (getSchemas), long
    // after `compositionTree` is decided, and a rolled-back composition clears
    // it again.
    if (!useFixture && compositionTree === undefined) {
      const note = await alternativeExportNote(
        file,
        detectComponentExport(file, options.target).name,
        finalSchemas,
        options.target,
      );
      if (note) onWarning(note);
    }
    return finalSchemas;
  };

  // M39: everything that shapes what gets measured, hashed together with the
  // measured sources. Feature drift lives here, so the environment probe only
  // has to guard the machine.
  // M89 defect 3: a thunk, not a frozen value -- `resolvedCss.files`/
  // `cssReport.files` can still change after this point (a stylesheet
  // dropped mid-run because it could not be read), and a verdict cached or
  // saved under a fingerprint that still names the dropped file would be
  // indistinguishable from one measured with it. Read fresh on every actual
  // (non-memoized) call instead of captured once here.
  const buildFingerprintConfig = (): string =>
    JSON.stringify({
      // M48: a transform changes the code that gets measured, exactly like the
      // React Compiler does, so it belongs in the identity of a cached verdict.
      transforms: options.noTransforms ? [] : detectProjectTransforms(projectRoot).map((t) => t.code),
      css: cssReport?.files ?? [],
      wrap: wrapPath ? path.relative(projectRoot, wrapPath).replace(/\\/g, "/") : null,
      reactCompiler: options.reactCompiler ?? "auto",
      // Only present when targeted, so an untargeted run's fingerprint: and
      // every baseline already stored against it: is byte-identical.
      ...(options.target ? { target: options.target } : {}),
      samples,
      cpuThrottle,
    });
  let fingerprintValue: string | undefined;
  const getSourceFingerprint = async (): Promise<string> => {
    if (fingerprintValue) return fingerprintValue;
    const graph = await projectSourceFiles(path.resolve(harnessPath));
    const extras: string[] = [];
    if (wrapPath) extras.push(wrapPath);
    // M44: nothing imports the preset module from the component graph, so an
    // edited preset would otherwise reuse a verdict about different values.
    if (presets) extras.push(presets.absolutePath);
    extras.push(...resolvedCss.files);
    if (path.resolve(metadataPath) !== path.resolve(harnessPath)) {
      extras.push(path.resolve(metadataPath));
    }
    extras.push(...projectConfigFingerprintFiles(projectRoot));
    fingerprintValue = computeSourceFingerprint(
      projectRoot,
      [...graph, ...extras],
      buildFingerprintConfig(),
    );
    return fingerprintValue;
  };

  const attachHarnessContext = (report: Report): void => {
    if (runWarnings.length > 0) {
      // M117 C1: one entry per distinct text, in first-occurrence order,
      // counted when the run produced it more than once. The three sites that
      // collect `harness.warnings` each append the whole static pre-build list,
      // so a run that rebuilt its harness recorded identical sentences twice.
      report.warnings = dedupeWarnings([...(report.warnings ?? []), ...runWarnings]);
    }
    if (cssReport) report.css = cssReport;

    // M65: a static import is not a finding. It becomes one only once a render
    // actually failed, which is what keeps a healthy run's report unchanged.
    if (providerCandidates.length > 0 && renderFailed(report)) {
      report.providerCandidates = providerCandidates;
      // M92 gap 3: additive, only when there is at least one -- a report
      // whose every candidate is direct stays exactly as it printed before.
      if (transitiveProviderCandidates.length > 0) {
        report.transitiveProviderCandidates = transitiveProviderCandidates;
      }
    }

    // M46: assembled from signals the run already produced, plus the one probe.
    // A run whose machine was busy must say so before anyone reads its numbers.
    if (noiseProbe.length > 0) {
      let unstableCount = 0;
      let metricCount = 0;
      for (const combo of report.combos) {
        for (const metric of [combo.mount, combo.rerender, combo.unmount]) {
          if (!metric) continue;
          metricCount++;
          if (metric.unstable) unstableCount++;
        }
      }
      const noise = buildNoiseReport({
        probeSamples: noiseProbe,
        unstableCount,
        metricCount,
        contextRetries,
      });
      report.noise = noise;
      // M117 C6: the JSON carries the full text — the machine sentence, the
      // provisional-numbers sentence, and (once the baseline step below knows a
      // comparison happened) the baseline sentence. The terminal and the
      // markdown fold shorten it to one line, in src/report.ts.
      const noiseWarning = formatNoiseWarning(noise, report.baseline !== undefined);
      if (noiseWarning) {
        report.warnings = dedupeWarnings([...(report.warnings ?? []), noiseWarning]);
      }
    }

    if (presets && presetApplied.size > 0) {
      report.propPresets = { path: presets.path, props: [...presetApplied].sort() };
    }
    // M48: which of the project's own transforms compiled this run.
    if (activeTransforms && activeTransforms.length > 0) {
      report.projectTransforms = activeTransforms;
    }
    const compiler = harness?.reactCompiler;
    const compilerReport = buildReactCompilerReport(compiler);
    if (compilerReport) {
      report.reactCompiler = compilerReport;
    }
    if (compiler?.warning) {
      report.warnings = [...(report.warnings ?? []), compiler.warning];
    }
  };

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

    // M42: before any harness directory or dev server exists. A component whose
    // graph reaches server-only code cannot mount in a browser at all, and the
    // check costs a source walk, not a boot.
    progress("preflight: walking the import graph");
    const preflight = runPreflight({
      projectRoot,
      entries: [harnessPath, ...(wrapPath ? [wrapPath] : [])],
      // The export the entry actually mounts, not the display name.
      componentName: detectComponentExport(harnessPath, options.target).name,
      ...(vueCompiler ? { vueCompiler } : {}),
    });
    // M91 (commerce-F3): folded in before the hard-hit check below runs, so
    // a sync component whose JSX composes an async server component one hop
    // away gates identically to targeting that child directly.
    preflight.hard.push(...composedChildPreflightHits(harnessPath, projectRoot));
    // M92 (dub button.tsx): entries above is [harnessPath, wrapPath?] -- see
    // providersFromEntry's own comment (src/preflight.ts) for why a hit
    // discovered only through the wrapper is excluded here rather than
    // mislabeled as something the component imports.
    const componentEntryRelative = path
      .relative(projectRoot, path.resolve(harnessPath))
      .replace(/\\/g, "/");
    const componentOwnProviders = providersFromEntry(preflight.providers, componentEntryRelative);
    // M65: recorded now, published only if a combo actually fails to render.
    providerCandidates = providerCandidateLabels(componentOwnProviders);
    // M92 gap 3: the same labels, restricted to hits reached only
    // transitively -- providerCandidateLabels' own dedup runs independently
    // over this filtered subset, so a label present in both arrays is
    // byte-identical between them (hints.ts matches by exact string).
    transitiveProviderCandidates = providerCandidateLabels(
      componentOwnProviders.filter((hit) => !isDirectProviderHit(hit)),
    );
    for (const hit of preflight.soft) runWarnings.push(NODE_BUILTIN_WARNING(hit));

    const loadableTransforms = new Set(
      (options.noTransforms ? [] : detectProjectTransforms(projectRoot)).map((t) => t.code),
    );
    // M110 C4 (logto-F3): I3's classifier in `src/preflight.ts`, shared with
    // the dry run's own warning list, so the two modes cannot disagree about
    // which transform hits are worth a warning or in which order they are said.
    const candidateTransformHits = classifyProjectTransformHits(projectRoot, preflight.transforms, {
      ...(options.noTransforms ? { noTransforms: true } : {}),
    });
    transformHits = candidateTransformHits.map(({ hit }) => hit);
    // Named up front, and again on the way out if the run dies: a transform
    // the harness cannot apply is the first thing to check.
    for (const { hit, availability } of candidateTransformHits) {
      runWarnings.push(PROJECT_TRANSFORM_WARNING(hit, availability));
    }
    if (loadableTransforms.size > 0) {
      activeTransforms = [...loadableTransforms].sort();
    }
    // M78 loose end: wired into --explain-props (explainProps, above) but
    // never into the default run's own warning list. Zero cost when the
    // project has no next.config/webpack.config matching the shape (a single
    // probe-order file read).
    if (framework === "react") {
      const bundlerAlias = detectBundlerReactDomAlias(projectRoot);
      if (bundlerAlias) {
        runWarnings.push(BUNDLER_PREACT_ALIAS_WARNING(bundlerAlias.configFile, bundlerAlias.target));
      }
    }
    if (preflight.hard.length > 0) {
      if (options.noPreflight) {
        runWarnings.push(PREFLIGHT_BYPASSED_WARNING(preflight.hard));
      } else {
        // M79/M78: a preflight hard-rejection, not a build/runtime failure —
        // nothing has been built yet, so the diagnosis is already complete.
        // The marker lets the outer catch below skip stacking accumulated
        // warnings (e.g. an unrelated css-preprocessor note) on top of it.
        throw new PreflightHardRejectionError(preflightFailureMessage(preflight.hard));
      }
    }

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
      // M89 defect 3 (shadcn-ui, live proof): a discovered stylesheet can
      // resolve fine on disk and still fail to compile because something
      // IT references internally does not (Tailwind v4's generated
      // tailwind.css, gitignored/build-only) -- entryStylesheetImports'
      // own resolution never sees that nested reference, only Vite's real
      // PostCSS pipeline does, at this first real request. Governing
      // policy (M95 in specs/overview/02-milestones.md): skip unresolvable build
      // artifacts and measure anyway wherever possible -- the component
      // still renders, just unstyled. Scoped to ENOENT alone
      // (stylesheetReadFailureTarget), so a stylesheet that resolves and
      // then fails to *compile* (a real project error, e.g. twenty's sass
      // "Undefined mixin") is untouched and still fails the run loudly.
      const message = err instanceof Error ? err.message : String(err);
      const missingTarget =
        resolvedCss.files.length > 0 ? stylesheetReadFailureTarget(message) : undefined;
      if (!missingTarget) throw err;
      const droppedFiles = [...cssReport.files];
      onWarning(CSS_UNREADABLE_DROPPED_WARNING(missingTarget, droppedFiles));
      resolvedCss.files = [];
      cssReport.files = [];
      cssReport.layer = "unreadable";
      // M102 (shadcn-ui-F3): `details` used to be emptied here, so a JSON
      // reader saw `layer: "unreadable"` with no record of which stylesheet
      // was dropped — indistinguishable from a project that had none. Each
      // dropped file keeps its entry and carries the path that was actually
      // tried plus the reason it was dropped.
      // C-9: only one file caused the ENOENT. The others were dropped with it
      // when the harness rebuilt without any stylesheet, so "not readable at X"
      // is false of them; they keep the byte and rule counts buildCssReport had
      // already computed.
      const priorDetails = cssReport.details ?? [];
      cssReport.details = droppedFiles.map((file) => {
        const prior = priorDetails.find((d) => d.file === file);
        const causedIt = missingTarget.split("\\").join("/").endsWith(file);
        return {
          file,
          bytes: prior?.bytes ?? 0,
          rules: prior?.rules ?? 0,
          unreadable: causedIt
            ? `not readable at ${missingTarget}; dropped, and the run measured unstyled`
            : `dropped alongside ${missingTarget}, which could not be read; the run measured unstyled`,
        };
      });
      delete cssReport.onlyCandidate;
      delete cssReport.noEntryInPackage;
      delete cssReport.runtimeEngines;
      delete cssReport.runtimeEnginesRecognised;
      // The early cache-lookup fingerprint (tryReuseStoredVerdict, above)
      // may already have memoized a value computed with the now-dropped
      // file still in it; un-memoize so a later --save-baseline call
      // recomputes against the stylesheet this run actually measured with
      // (none), not the one it started out intending to use.
      fingerprintValue = undefined;
      await harness!.cleanup();
      harness = await buildAndServe(harnessPath, { ...composedHarnessOpts, cssFiles: undefined });
      if (harness.warnings) runWarnings.push(...withoutHonoredPlugins(harness.warnings));
      // Not wrapped again: a second failure here is a different, genuine
      // problem (or the same page never recovering for an unrelated
      // reason) and must propagate and fail the run like any other.
      await enterHarnessPage();
    }

    // A structurally inferred tree can violate a library's nesting rules and
    // mount to an empty root. Measuring that produces confident numbers about
    // a scene nobody wrote, so prove it renders before trusting it.
    if (useComposition) {
      const trial = await trialMountComposition(page);
      if (shouldRollbackComposition(trial)) {
        runWarnings.push(COMPOSITION_EMPTY_WARNING(compositionTree!.root));
        if (options.initFixture) {
          runWarnings.push(
            writeFixtureScaffold(resolvedPath, componentExports ?? [], compositionTree!),
          );
        }
        // M80: the rolled-back mount is about to measure the bare root
        // alone, same shape as the never-composed case above. Checked before
        // `compositionTree`/`componentExports` are cleared below: a root
        // that self-wraps in one element (nonzero domNodeCount, so
        // renderHealth never fires) but still declares recognized sibling
        // parts must not read as an unqualified pass.
        {
          const rootName = compositionTree!.root;
          const typeImportNames = await extractRelativeTypeImports(resolvedPath);
          const siblingExports = (componentExports ?? []).filter((e) => e.name !== rootName);
          const siblings = declaredCompositionSiblings(rootName, siblingExports, typeImportNames);
          if (siblings.length > 0) {
            disclosureReason = "uncomposed";
            runWarnings.push(UNCOMPOSED_SIBLINGS_WARNING(rootName, siblings.map((s) => s.name)));
          }
        }
        compositionTree = undefined;
        componentExports = undefined;
        await harness.cleanup();
        harness = await buildAndServe(harnessPath, baseHarnessOpts);
        if (harness.warnings) runWarnings.push(...withoutHonoredPlugins(harness.warnings));
        await enterHarnessPage();
      }
    }
    const composed = compositionTree !== undefined;

    // M102 / I7 (excalidraw-F2): read once, on the harness this run will
    // actually measure on, before throttling and before any traced window.
    if (cssReport.details && cssReport.details.length > 0) {
      const stats = await probeStylesheetMatchStats(page);
      for (const stat of stats ?? []) {
        // C-16: one direction only. `d.file.endsWith(stat.file)` plus `find`'s
        // first hit could attach a probe result to the wrong entry whenever two
        // discovered stylesheets share a trailing segment.
        const normalized = stat.file.split("\\").join("/");
        const detail = cssReport.details.find((d) => normalized.endsWith(d.file));
        if (!detail) continue;
        detail.matchedRules = stat.matched;
        // C-8: `stat.rules` is what the CSSOM probe actually read;
        // `detail.rules` is the static count. The probe reports `rules: 0` for
        // a sheet it could not find or could not read (cross-origin), and
        // warning off the static count there asserts something about a sheet
        // nothing inspected.
        if (stat.rules > 0 && stat.matched === 0) {
          onWarning(STYLESHEET_MATCHED_NOTHING_WARNING(detail.file, stat.rules));
        }
      }
    }

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
    // M79 (1b): subsumes the old transformHits-only special case —
    // transformHits's own warnings are already in runWarnings (pushed above),
    // and 1a's harness.ts throw sites attach their own buildWarnings on the
    // error itself, so both sources fold into one block here.
    // M90 (ant-design-F5): `cssDecisionWarning` is always a non-empty
    // string, so `combined` is never empty and every throw that reaches here
    // gets the block — including a thrown value that is not `instanceof
    // Error` (ant-design's raw esbuild resolve failure took exactly this
    // shape, and the old `if (err instanceof Error)` guard silently dropped
    // accumulation for it).
    const carried =
      err instanceof Error ? ((err as Error & { warnings?: string[] }).warnings ?? []) : [];
    const combined = [...new Set([cssDecisionWarning, ...runWarnings, ...carried])];
    const message = err instanceof Error ? err.message : String(err);
    // M92: surface 2 of the shared pipeline (presentBundlerFailure,
    // src/harness.ts) -- the dev server booted fine (buildAndServe's own
    // catch, surface 1, never saw this) and a transform failed afterwards on
    // a real request, arriving as page-error text inside a "did not become
    // ready" / fatal-page-error message (twenty's sass "Undefined mixin",
    // shadcn-ui's postcss ENOENT and Vite import-resolve failure). Harmless
    // to run on every other throw that reaches this catch too: the diagnosers
    // match only specific raw bundler shapes, and the fallback stripper is
    // conservative (keeps a frame pointing into the target repo).
    const presented = presentBundlerFailure(message, projectRoot, combined);
    // M105 I12 (primevue-F2): a mount-phase abort throws before any report
    // exists, so hintsForReport never runs and the catalog entry for exactly
    // this failure ("a missing provider needs --wrap pointing at a setup
    // module") was unreachable — two different primevue root causes both
    // printed a bare browser stack with no remediation text at all. The block
    // is appended next to the accumulated warnings, so every consumer of this
    // message shows it without a new channel.
    // M114 C2, C3 (ark-F2, vitesse-F1): both hints name a cause only from what
    // this run read — the measured SFC's own setup block (I8) and the vite
    // config keys the harness recorded as read-but-not-honored (I10).
    const abortHints = formatMountAbortHints(message, {
      usesInject: await measuredSfcUsesInject(resolvedPath, projectRoot, (warning) => {
        combined.push(warning);
      }),
      ...(viteConfigIgnoredKeys(combined) ?? {}),
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
