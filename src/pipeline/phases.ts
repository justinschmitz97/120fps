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
  withholdInteractionFailsUnderHostileNoise,
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
  BUNDLED_PREPROCESSOR_DISCLOSED,
  bundledPreprocessorStylesheetWarning,
  stylesheetMatchWarnings,
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

// Everything resolved from the filesystem before anything is built.
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
  // Collected before the run's warning list exists; folded into it below.
  const frameworkWarnings: string[] = [];
  // Before the wrapper: a Vue project's wrapper is an SFC, and a stray .tsx renders nothing.
  const framework = resolveFramework(options.framework ?? "auto", projectRoot, harnessPath, (w) =>
    frameworkWarnings.push(w),
  );
  // What the wrapper probe had to fall back to, folded into the run's warnings below.
  const wrapWarnings: string[] = [];
  const { wrapPath, wrapAutoDetected } = resolveWrapPath(options, projectRoot, framework, wrapWarnings);
  // What discovery had to guess at, folded into the run's warnings below.
  const cssWarnings: string[] = [];
  const resolvedCss = resolveCssFiles(options, projectRoot, cssWarnings, {
    ...(wrapPath ? { wrapPath } : {}),
    measuredFile: resolvedPath,
  });
  const cssReport = buildCssReport(resolvedCss, projectRoot);
  // Kept out of runWarnings, which already carry a Stylesheets: line; only the crash path reads it.
  const cssDecisionWarning = formatStylesheetsLine(cssReport);
  // Mirrored out at once: a detached async rejection never reaches this function's own catch.
  options.onWarning?.(cssDecisionWarning);
  // A fixture already owns its scene, so presets never apply there.
  const presetPath = useFixture ? undefined : detectPropPresets(resolvedPath);
  const presets = presetPath ? loadPropPresets(presetPath, projectRoot) : undefined;
  // The dry run's producer, so both modes name the rejected sibling in the same words.
  const presetShapeWarning = useFixture
    ? undefined
    : presetShapeDisclosure(resolvedPath, projectRoot);
  // Known before extraction runs, so the remedies a preset answers never reach the terminal.
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

// The one schema read the measurement path uses: extraction, presets, their disclosures.
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
    // Covers both Vue scope exclusions ADR 0002 defines, so either downgrades to one disclosure.
    let sawPropsScopeExclusion = false;
    const extracted = await extractPropsDetailed(file, {
      ...(options.target ? { target: options.target } : {}),
      onWarning: (warning) => {
        if (isVuePropsScopeExclusionWarning(warning)) sawPropsScopeExclusion = true;
        // The preset loads before extraction, so an answered remedy is dropped as it is produced.
        if (presetSuppliedProps.length > 0 && presetAnswersRemedy(warning, presetSuppliedProps)) {
          return;
        }
        // A surviving remedy names the loaded preset instead of asking for a file.
        onWarning(presets ? remedyNamesLoadedPreset(warning, presets.path) : warning);
      },
    });
    const raw = extracted.schemas;
    const asProjectPath = (target: string): string =>
      toPosix(path.relative(projectRoot, target));
    // Decided by the filesystem, so the dry run and the real run cannot word these differently.
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
    // The only place a Vue run sets it: analyze.ts's auto-composition guard skips rendererIsVue.
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
    // A composed scene owns the render, so a retarget note would contradict what it measured.
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

// The identity of a run: the source graph plus every file and option that changes the numbers.
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
  // A thunk: cssReport.files can still lose a stylesheet mid-run, and the hash must follow.
  const buildFingerprintConfig = (): string =>
    JSON.stringify({
      // A transform changes the code that gets measured, so it belongs in the cached identity.
      transforms: options.noTransforms ? [] : detectProjectTransforms(projectRoot).map((t) => t.code),
      css: cssReport?.files ?? [],
      wrap: wrapPath ? toPosix(path.relative(projectRoot, wrapPath)) : null,
      reactCompiler: options.reactCompiler ?? "auto",
      // Present only when targeted, so an untargeted run's stored baselines stay byte-identical.
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
    // Nothing imports the preset from the component graph, so an edit would reuse a stale verdict.
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

// Everything a report carries that the run, rather than a measurement pass, knows.
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
      // Every site collecting harness.warnings appends the whole pre-build list, so texts repeat.
      report.warnings = dedupeWarnings([...(report.warnings ?? []), ...runWarnings]);
    }
    if (cssReport) report.css = cssReport;

    // A static import becomes a finding only once a render failed; a healthy report is unchanged.
    if (providerCandidates.length > 0 && renderFailed(report)) {
      report.providerCandidates = providerCandidates;
      // Additive: a report whose every candidate is direct prints exactly as it did.
      if (transitiveProviderCandidates.length > 0) {
        report.transitiveProviderCandidates = transitiveProviderCandidates;
      }
    }

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
      // The verdict's own noise suppression: the classification counts the metrics the combos
      // carry, so it exists only here, after buildReport has written every verdict.
      const withheldFail = withholdInteractionFailsUnderHostileNoise(report);
      if (withheldFail) {
        report.warnings = dedupeWarnings([...(report.warnings ?? []), withheldFail]);
      }
      // The JSON carries the full text; report/terminal.ts shortens it to one line.
      const noiseWarning = formatNoiseWarning(noise, report.baseline !== undefined);
      if (noiseWarning) {
        report.warnings = dedupeWarnings([...(report.warnings ?? []), noiseWarning]);
      }
    }

    if (presets && presetApplied.size > 0) {
      report.propPresets = { path: presets.path, props: [...presetApplied].sort() };
    }
    // Which of the project's own transforms compiled this run.
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

// The import-graph walk and everything it decides, before a harness or dev server exists.
export function runPreflightPhase(input: {
  options: AnalyzeOptions;
  projectRoot: string;
  harnessPath: string;
  framework: "react" | "vue" | "vanilla";
  runWarnings: string[];
  progress: (line: string) => void;
  wrapPath?: string;
  vueCompiler?: VueSfcCompiler;
  // The stylesheets this run injects, which no import edge of the measured graph names.
  cssFiles?: string[];
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
  // A graph reaching server-only code cannot mount at all, and this costs a walk, not a boot.
  progress("preflight: walking the import graph");
  const preflight = runPreflight({
    projectRoot,
    entries: [harnessPath, ...(wrapPath ? [wrapPath] : [])],
    // The export the entry actually mounts, not the display name.
    componentName: detectComponentExport(harnessPath, options.target).name,
    ...(vueCompiler ? { vueCompiler } : {}),
  });
  // Folded in before the hard-hit check, so a composed child gates as a direct target would.
  preflight.hard.push(...composedChildPreflightHits(harnessPath, projectRoot));
  // A hit reached only through the wrapper is excluded here: see providersFromEntry.
  const componentEntryRelative = toPosix(path.relative(projectRoot, path.resolve(harnessPath)));
  const componentOwnProviders = providersFromEntry(preflight.providers, componentEntryRelative);
  // Recorded now, published only if a combo actually fails to render.
  providerCandidates = providerCandidateLabels(componentOwnProviders);
  // report/hints.ts matches by exact string, so a label in both arrays must be byte-identical.
  transitiveProviderCandidates = providerCandidateLabels(
    componentOwnProviders.filter((hit) => !isDirectProviderHit(hit)),
  );
  for (const hit of preflight.soft) runWarnings.push(NODE_BUILTIN_WARNING(hit));

  const loadableTransforms = new Set(
    (options.noTransforms ? [] : detectProjectTransforms(projectRoot)).map((t) => t.code),
  );
  // Shared with the dry run's warning list, so the two modes agree on which hits warn, and when.
  const candidateTransformHits = classifyProjectTransformHits(projectRoot, preflight.transforms, {
    ...(options.noTransforms ? { noTransforms: true } : {}),
  });
  transformHits = candidateTransformHits.map(({ hit }) => hit);
  // Named up front, and again if the run dies: an unappliable transform is the first suspect.
  for (const { hit, availability } of candidateTransformHits) {
    runWarnings.push(PROJECT_TRANSFORM_WARNING(hit, availability));
  }
  // The injected stylesheet is no edge of the measured graph, so the classifier above never sees
  // it. Disclosed only when that classifier said nothing: one Sass disclosure per run.
  if (!options.noTransforms && !runWarnings.some((w) => w.includes(BUNDLED_PREPROCESSOR_DISCLOSED))) {
    const injected = bundledPreprocessorStylesheetWarning(input.cssFiles ?? [], projectRoot);
    if (injected !== undefined) runWarnings.push(injected);
  }
  if (loadableTransforms.size > 0) {
    activeTransforms = [...loadableTransforms].sort();
  }
  // The dry run pushes this same line, so both modes disclose an aliased react-dom.
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
      // Nothing is built yet, so the diagnosis is complete and the outer catch adds nothing to it.
      throw new PreflightHardRejectionError(preflightFailureMessage(preflight.hard));
    }
  }
  return { providerCandidates, transitiveProviderCandidates, transformHits, activeTransforms };
}

// Drop the stylesheet, record why on every file that went with it, and measure unstyled.
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
  // ENOENT only (stylesheetReadFailureTarget): a sheet that fails to compile still fails the run.
  const message = err instanceof Error ? err.message : String(err);
  const missingTarget =
    resolvedCss.files.length > 0 ? stylesheetReadFailureTarget(message) : undefined;
  if (!missingTarget) throw err;
  const droppedFiles = [...cssReport.files];
  onWarning(CSS_UNREADABLE_DROPPED_WARNING(missingTarget, droppedFiles));
  resolvedCss.files = [];
  cssReport.files = [];
  cssReport.layer = "unreadable";
  // Every dropped file keeps an entry: layer "unreadable" alone cannot say which sheet went.
  const priorDetails = cssReport.details ?? [];
  cssReport.details = droppedFiles.map((file) => {
    const prior = priorDetails.find((d) => d.file === file);
    // Only one file caused the ENOENT; "not readable at X" would be false of the rest.
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
  // The cache lookup may have memoized a hash naming the dropped file; --save-baseline needs this.
  resetSourceFingerprint();
  await rebuildHarness({ ...composedHarnessOpts, cssFiles: undefined });
  // Not wrapped again: a second failure is a different problem and must fail the run.
  await enterHarnessPage();
}

// What a run that died says: accumulated warnings, the bundler failure, the mount-abort hints.
export async function classifyHarnessFault(input: {
  err: unknown;
  projectRoot: string;
  resolvedPath: string;
  cssDecisionWarning: string;
  runWarnings: string[];
}): Promise<{ presented: string; combined: string[]; abortHints: string }> {
  const { err, projectRoot, resolvedPath, cssDecisionWarning, runWarnings } = input;
  // Warnings the harness attached to the error itself fold in with the run's own.
  const carried =
    err instanceof Error ? ((err as Error & { warnings?: string[] }).warnings ?? []) : [];
  // cssDecisionWarning is never empty, so even a thrown non-Error still gets the warning block.
  const combined = [...new Set([cssDecisionWarning, ...runWarnings, ...carried])];
  const message = err instanceof Error ? err.message : String(err);
  // The dev server booted, then a transform failed on a real request; harmless on other throws.
  const presented = presentBundlerFailure(message, projectRoot, combined);
  // A mount abort throws before any report exists, so hintsForReport never runs for this path.
  const abortHints = formatMountAbortHints(message, {
    usesInject: await measuredSfcUsesInject(resolvedPath, projectRoot, (warning) => {
      combined.push(warning);
    }),
    ...(viteConfigIgnoredKeys(combined) ?? {}),
  });
  return { presented, combined, abortHints };
}

// Say so, keep what the never-composed path discloses, and rebuild on the bare export.
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
    // Checked before the composition is cleared: a self-wrapping root must not read as a pass.
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
// Read on the harness this run measures on, before throttling and any traced window.
if (cssReport.details && cssReport.details.length > 0) {
  const stats = await probeStylesheetMatchStats(page);
  // The probe reports rules: 0 for a sheet it could not read, and detail.rules is only static.
  const probed: NonNullable<CssReport["details"]> = [];
  for (const stat of stats ?? []) {
    // One direction only: the reverse match misattaches when two sheets share a trailing segment.
    const normalized = stat.file.split("\\").join("/");
    const detail = cssReport.details.find((d) => normalized.endsWith(d.file));
    if (!detail) continue;
    detail.matchedRules = stat.matched;
    probed.push({ ...detail, rules: stat.rules, matchedRules: stat.matched });
  }
  // One disclosure for the whole run: a wrong pick reads differently from an unused feature sheet.
  for (const warning of stylesheetMatchWarnings({ layer: cssReport.layer, details: probed })) {
    onWarning(warning);
  }
}
}
