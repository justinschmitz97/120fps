import path from "node:path";
import { type AnalyzeOptions } from "./analyze.js";
import { BUNDLER_PREACT_ALIAS_WARNING, type BuildHarnessOptions, CSS_UNREADABLE_DROPPED_WARNING, type HarnessResult, detectBundlerReactDomAlias, detectComponentExport, presentBundlerFailure, stylesheetReadFailureTarget } from "../harness/index.js";
import { detectProjectTransforms } from "../project/index.js";
import {
  COMPOSITION_EMPTY_WARNING,
  type CompositionTree,
  type ExportInfo,
  type PropPresets,
  type PropSchema,
  UNCOMPOSED_SIBLINGS_WARNING,
  UNKNOWN_PRESET_PROPS_WARNING,
  applyPropPresets,
  declaredCompositionSiblings,
  detectPropPresets,
  extractPropsDetailed,
  extractRelativeTypeImports,
  isVuePropsScopeExclusionWarning,
  loadPropPresets,
  projectSourceFiles,
  shouldRollbackComposition,
} from "../props/index.js";
import {
  type CssReport,
  type Report,
  computeSourceFingerprint,
  dedupeWarnings,
  formatMountAbortHints,
  formatStylesheetsLine,
} from "../report/index.js";
import {
  NODE_BUILTIN_WARNING,
  PREFLIGHT_BYPASSED_WARNING,
  PROJECT_TRANSFORM_WARNING,
  PreflightHardRejectionError,
  type PreflightHit,
  type VueSfcCompiler,
  classifyProjectTransformHits,
  isDirectProviderHit,
  preflightFailureMessage,
  providerCandidateLabels,
  providersFromEntry,
  runPreflight,
} from "../project/index.js";
import {
  RE_EXPORT_MEASURED_DISCLOSURE,
  UNRESOLVED_RE_EXPORT_WARNING,
  alternativeExportNote,
  measuredSfcUsesInject,
  presetAnswersRemedy,
  presetShapeDisclosure,
  remedyNamesLoadedPreset,
  renderFailed,
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
import { buildCssReport, buildReactCompilerReport } from "./build-report.js";
import { buildNoiseReport, formatNoiseWarning } from "../browser/index.js";
import { composedChildPreflightHits, trialMountComposition, writeFixtureScaffold } from "./fixtures.js";
import { projectConfigFingerprintFiles } from "./verdict-reuse.js";
import { toPosix } from "../shared/index.js";

// Everything the run resolves from the filesystem before it builds anything:
// where the project is, which framework renders it, which wrapper and
// stylesheets apply, and which prop preset supplies values.
export function prepareRunInputs(input: {
  options: AnalyzeOptions;
  resolvedPath: string;
  harnessPath: string;
  useFixture: boolean;
}): {
  projectRoot: string;
  relativeComponent: string;
  resolutionWarnings: string[];
  framework: "react" | "vue" | "vanilla";
  wrapPath: string | undefined;
  wrapAutoDetected: boolean;
  resolvedCss: ReturnType<typeof resolveCssFiles>;
  cssReport: CssReport;
  cssDecisionWarning: string;
  presets: PropPresets | undefined;
  presetShapeWarning: string | undefined;
  presetSuppliedProps: string[];
} {
  const { options, resolvedPath, harnessPath, useFixture } = input;
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
  return {
    projectRoot,
    relativeComponent,
    resolutionWarnings: [...frameworkWarnings, ...cssWarnings, ...wrapWarnings],
    framework,
    wrapPath,
    wrapAutoDetected,
    resolvedCss,
    cssReport,
    cssDecisionWarning,
    presets,
    presetShapeWarning,
    presetSuppliedProps,
  };
}

// The one schema read the measurement path uses: extraction, preset
// application, and every disclosure those two produce.
export function createSchemaExtractor(deps: {
  options: AnalyzeOptions;
  projectRoot: string;
  presets: PropPresets | undefined;
  presetSuppliedProps: string[];
  presetApplied: Set<string>;
  onWarning: (warning: string) => void;
  useFixture: boolean;
  getCompositionTree: () => CompositionTree | undefined;
  getDisclosureReason: () => "uncomposed" | "propsExcluded" | undefined;
  setDisclosureReason: (reason: "propsExcluded") => void;
}): (file: string) => Promise<PropSchema[]> {
  const { options, projectRoot, presets, presetSuppliedProps, presetApplied, onWarning, useFixture } = deps;
  return async (file: string): Promise<PropSchema[]> => {
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
      toPosix(path.relative(projectRoot, target));
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
    if (raw.length === 0 && sawPropsScopeExclusion && deps.getDisclosureReason() === undefined) {
      deps.setDisclosureReason("propsExcluded");
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
    if (!useFixture && deps.getCompositionTree() === undefined) {
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
}

// The identity of what this run measures: the component's source graph plus
// every file and option that changes the numbers.
export function createSourceFingerprint(deps: {
  options: AnalyzeOptions;
  projectRoot: string;
  harnessPath: string;
  metadataPath: string;
  cssReport: CssReport;
  resolvedCss: ReturnType<typeof resolveCssFiles>;
  presets: PropPresets | undefined;
  wrapPath: string | undefined;
  samples: number;
  cpuThrottle: number;
}): { getSourceFingerprint: () => Promise<string>; resetSourceFingerprint: () => void } {
  const { options, projectRoot, harnessPath, metadataPath, cssReport, resolvedCss, presets, wrapPath, samples, cpuThrottle } = deps;
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
      wrap: wrapPath ? toPosix(path.relative(projectRoot, wrapPath)) : null,
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
  return { getSourceFingerprint, resetSourceFingerprint: () => (fingerprintValue = undefined) };
}

// Everything a report carries that the run, not a measurement pass, knows:
// accumulated warnings, the CSS decision, provider candidates, the noise
// probe, the applied preset and the compiler the harness used.
export function createHarnessContextAttacher(deps: {
  runWarnings: string[];
  cssReport: CssReport;
  presets: PropPresets | undefined;
  presetApplied: Set<string>;
  state: () => {
    providerCandidates: string[];
    transitiveProviderCandidates: string[];
    noiseProbe: number[];
    contextRetries: number;
    activeTransforms: string[] | undefined;
    harness: HarnessResult | undefined;
  };
}): (report: Report) => void {
  const { runWarnings, cssReport, presets, presetApplied } = deps;
  return (report: Report): void => {
    const { providerCandidates, transitiveProviderCandidates, noiseProbe, contextRetries, activeTransforms, harness } =
      deps.state();
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
}

// The import-graph walk and everything it decides, before a harness directory
// or a dev server exists.
export function runPreflightPhase(input: {
  options: AnalyzeOptions;
  projectRoot: string;
  harnessPath: string;
  framework: "react" | "vue" | "vanilla";
  runWarnings: string[];
  progress: (line: string) => void;
  wrapPath?: string;
  vueCompiler?: VueSfcCompiler;
}): {
  providerCandidates: string[];
  transitiveProviderCandidates: string[];
  transformHits: PreflightHit[];
  activeTransforms: string[] | undefined;
} {
  const { options, projectRoot, harnessPath, framework, runWarnings, progress, wrapPath, vueCompiler } = input;
  let providerCandidates: string[] = [];
  let transitiveProviderCandidates: string[] = [];
  let transformHits: PreflightHit[] = [];
  let activeTransforms: string[] | undefined;
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
  const componentEntryRelative = toPosix(path.relative(projectRoot, path.resolve(harnessPath)));
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
  return { providerCandidates, transitiveProviderCandidates, transformHits, activeTransforms };
}

// A stylesheet that resolved on disk and still could not be read at the first
// real request: drop it, record why on every file that went with it, and
// measure the component unstyled.
export async function recoverFromUnreadableStylesheet(
  err: unknown,
  deps: {
    resolvedCss: ReturnType<typeof resolveCssFiles>;
    cssReport: CssReport;
    composedHarnessOpts: BuildHarnessOptions;
    onWarning: (warning: string) => void;
    resetSourceFingerprint: () => void;
    rebuildHarness: (opts: BuildHarnessOptions) => Promise<void>;
    enterHarnessPage: () => Promise<void>;
  },
): Promise<void> {
  const { resolvedCss, cssReport, composedHarnessOpts, onWarning, resetSourceFingerprint, rebuildHarness, enterHarnessPage } = deps;
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
  resetSourceFingerprint();
  await rebuildHarness({ ...composedHarnessOpts, cssFiles: undefined });
  // Not wrapped again: a second failure here is a different, genuine
  // problem (or the same page never recovering for an unrelated
  // reason) and must propagate and fail the run like any other.
  await enterHarnessPage();
}

// What a run that died says: the accumulated warnings, the bundler failure
// presented in the project's own terms, and the mount-abort hints.
export async function classifyHarnessFault(input: {
  err: unknown;
  projectRoot: string;
  resolvedPath: string;
  cssDecisionWarning: string;
  runWarnings: string[];
}): Promise<{ presented: string; combined: string[]; abortHints: string }> {
  const { err, projectRoot, resolvedPath, cssDecisionWarning, runWarnings } = input;
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
  return { presented, combined, abortHints };
}

// A trial mount that produced an empty root: say so, keep whatever the
// never-composed path would have disclosed, and rebuild on the bare export.
export async function rollbackEmptyComposition(input: {
  page: import("playwright").Page;
  options: AnalyzeOptions;
  resolvedPath: string;
  compositionTree: CompositionTree;
  componentExports: ExportInfo[] | undefined;
  runWarnings: string[];
  baseHarnessOpts: BuildHarnessOptions;
  rebuildHarness: (opts: BuildHarnessOptions) => Promise<void>;
  enterHarnessPage: () => Promise<void>;
  clearComposition: () => void;
  setDisclosureReason: () => void;
}): Promise<void> {
  const { page, options, resolvedPath, compositionTree, componentExports, runWarnings } = input;
  const { baseHarnessOpts, rebuildHarness, enterHarnessPage, clearComposition, setDisclosureReason } = input;
  const trial = await trialMountComposition(page);
  if (shouldRollbackComposition(trial)) {
    runWarnings.push(COMPOSITION_EMPTY_WARNING(compositionTree.root));
    if (options.initFixture) {
      runWarnings.push(
        writeFixtureScaffold(resolvedPath, componentExports ?? [], compositionTree),
      );
    }
    // M80: the rolled-back mount is about to measure the bare root
    // alone, same shape as the never-composed case above. Checked before
    // `compositionTree`/`componentExports` are cleared below: a root
    // that self-wraps in one element (nonzero domNodeCount, so
    // renderHealth never fires) but still declares recognized sibling
    // parts must not read as an unqualified pass.
    {
      const rootName = compositionTree.root;
      const typeImportNames = await extractRelativeTypeImports(resolvedPath);
      const siblingExports = (componentExports ?? []).filter((e) => e.name !== rootName);
      const siblings = declaredCompositionSiblings(rootName, siblingExports, typeImportNames);
      if (siblings.length > 0) {
        setDisclosureReason();
        runWarnings.push(UNCOMPOSED_SIBLINGS_WARNING(rootName, siblings.map((s) => s.name)));
      }
    }
    clearComposition();
    await rebuildHarness(baseHarnessOpts);
    await enterHarnessPage();
  }
}

export async function recordStylesheetMatches(input: {
  page: import("playwright").Page;
  cssReport: CssReport;
  onWarning: (warning: string) => void;
}): Promise<void> {
  const { page, cssReport, onWarning } = input;
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
}
