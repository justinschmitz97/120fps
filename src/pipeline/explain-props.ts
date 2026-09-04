import fs from "node:fs";
import path from "node:path";
import {
  collectStaticPreBuildWarnings,
  detectComponentExport,
  assertReactDomClient,
  assertRendererSupported,
  rendererFor,
  detectBundlerReactDomAlias,
  BUNDLER_PREACT_ALIAS_WARNING,
} from "../harness/index.js";
import {
  extractPropsDetailed,
  extractExports,
  extractAllProps,
  detectScalingProps,
  type PropSchema,
  detectPropPresets,
  loadPropPresets,
  applyPropPresets,
  isPresetRef,
  UNKNOWN_PRESET_PROPS_WARNING,
  inferComposition,
  shouldAutoActivateMatrix,
} from "../props/index.js";
import {
  runPreflight,
  preflightFailureMessage,
  NODE_BUILTIN_WARNING,
  PROJECT_TRANSFORM_WARNING,
  PREFLIGHT_BYPASSED_WARNING,
  classifyProjectTransformHits,
  isVueFile,
  loadVueCompiler,
  VUE_COMPILER_MISSING,
} from "../project/index.js";
import {
  CURVE_NOT_ACTIVATED_WARNING,
  formatStylesheetsLine,
  formatPhaseDuration,
  dedupeWarnings,
} from "../report/index.js";
import { formatAccumulatedWarnings } from "./analyze.js";
import { buildCssReport } from "./build-report.js";
import { type RunCostEstimate, estimateExplainedRunCost } from "./estimate.js";
import { type FixtureProvenance, composedChildPreflightHits, detectFixture, isFixturePath } from "./fixtures.js";
import { DRY_RUN_RUNTIME_ONLY_NOTE, type PredictedMode, predictMode } from "./modes/context.js";
import { MATRIX_SUPPRESSED_BY_COMPOSITION_WARNING, MATRIX_SUPPRESSED_BY_FIXTURE_WARNING } from "./modes/matrix.js";
import {
  RE_EXPORT_MEASURED_DISCLOSURE,
  UNRESOLVED_RE_EXPORT_WARNING,
  ZERO_PROPS_WARNING,
  alternativeExportNote,
  explainsZeroPropCount,
  presetShapeDisclosure,
  remediesAfterPreset,
  suppressHonoredPluginNote,
} from "./remedies.js";
import { resolveCssFiles, resolveFramework, resolveProjectPaths, resolveWrapPath } from "./resolve.js";
import { toPosix } from "../shared/index.js";

// --- M65 C1: --explain-props ---------------------------------------------

export interface ExplainedProp {
  name: string;
  kind: PropSchema["kind"];
  required: boolean;
  values: unknown[];
  degenerate?: string;
  // M100 (excalidraw-F4): every branch of a union the extractor collapsed to
  // one measurable kind, exactly as the collapsed-union warning lists them
  // (`number | "small" | "regular" | "wide"`). The value column renders from
  // this so the table and the warning cannot disagree; `values` still holds
  // only what the run would actually synthesize.
  unionBranches?: string[];
  // M103 / I8 (calcom-F2): the value the component itself falls back to when
  // the prop is omitted, and where that was read from. Extraction has carried
  // both since I8; the dry run never printed them, so the tool knew calcom
  // Button's six defaults and said nothing about any of them.
  defaultValue?: unknown;
  defaultSource?: "destructuring" | "withDefaults" | "defaultProps";
}

export interface PropsExplanation {
  componentPath: string;
  componentName: string;
  target?: string;
  // projectRoot-relative posix path, and the 1-based line of the declaration
  // the schema bound to. Absent for a Vue SFC and for a file with no component.
  bindingFile?: string;
  bindingLine?: number;
  // M114 C1 (gutenberg-F2): the measured file re-exports the component another
  // module declares, and the props below are that module's. Both paths, posix,
  // relative to the project root.
  reExport?: { barrel: string; module: string };
  exports: string[];
  props: ExplainedProp[];
  curve?: { propName: string; reason: string };
  matrixWouldActivate: boolean;
  // M83 #5 (base-ui-F6): the "Curve mode: would (not) activate" line only
  // predicts detectScalingProps's whole-run auto-activation. The M61
  // sibling-copies scale probe is a separate, unconditional mechanism
  // appended to every default combo-mode run for a non-fixture target with
  // no curve match — this predicts *that*, so the dry run's stated mode
  // matches what a real run on the same target would actually do.
  scaleProbeWillRun: boolean;
  // M100 (element-plus-F4): which mode the real dispatcher would pick for this
  // component, through the shared `predictMode`. `matrixWouldActivate` keeps
  // its own narrower meaning (the matrix predicate is satisfied) and stops
  // being what gets printed as a prediction.
  predictedMode: PredictedMode;
  // M100 (review C-5): why the matrix branch was unreachable, when it was.
  // "combo" alone cannot say, and the two readings need different sentences:
  // a flag the user typed, or a fixture that owns the props.
  // M110 C2 (supabase-F3, calcom-R1): "composed" is the third reading, and
  // the one the dry run used to be structurally unable to give.
  matrixIneligibleReason?: "no-matrix-flag" | "fixture" | "composed";
  // M110 C1: the dispatcher's own composition answer, decided from export
  // names and schemas. Absent when the run would measure the bound export
  // alone.
  composition?: { root: string; exportCount: number };
  // M110 review: the fixture that would supply the scene (projectRoot-relative
  // posix path), so the composition line does not claim the component would be
  // measured alone when a fixture owns the render.
  fixtureFile?: string;
  // Set when a scaling prop was detected and `--no-curve` suppressed it, so
  // "would not activate: no array or numeric scaling prop" is not printed over
  // a component that has one.
  curveSuppressedByFlag?: boolean;
  presetPath?: string;
  // M115 C6: what the real run this dry run predicts is about to cost.
  costEstimate?: RunCostEstimate;
  warnings: string[];
}

// The same resolution the pipeline performs, stopped before its first side
// effect: no harness directory, no dev server, no browser, no report file.
export async function explainProps(
  componentPath: string,
  // M100 / I3b (element-plus-F2): `framework` was absent here, so
  // resolveFramework below was hardcoded to "auto" and
  // FRAMEWORK_FLAG_NO_MOUNT_EFFECT_WARNING could never fire in a dry run —
  // `--framework vue --explain-props` was a silent no-op while the same flag
  // on the real run was a disclosed one.
  options: {
    target?: string;
    noPreflight?: boolean;
    framework?: "react" | "vue" | "vanilla" | "auto";
    // M100 (review C-5): the four flags that decide which mode a real run
    // takes. Without them the dry run predicted from its own detection alone,
    // so `--no-matrix --explain-props` still promised a matrix, `--isolate`
    // predicted curve or matrix, and `--fixture` predicted a matrix over props
    // the fixture supplies. Same names and types as `AnalyzeOptions`, so the
    // CLI forwards one shape to both entry points.
    curveMode?: boolean | { propName: string; propKind: "array" | "number" };
    matrixMode?: boolean;
    isolation?: { phases: string[]; memoryCycles?: number };
    fixturePath?: string;
    // M110 C1, C4: the two remaining flags that change what the dispatcher
    // decides from disk. Same names and types as `AnalyzeOptions`, so the CLI
    // forwards one shape to both entry points.
    skipAutoCompose?: boolean;
    noTransforms?: boolean;
    // M110 I2 (review): the static pre-build both modes read resolves the
    // external-dependency scan against the shim aliases, which `--no-shims`
    // removes. Without this flag a `--no-shims` real run could report a
    // different unresolved set than the dry run predicted from the same files.
    noShims?: boolean;
    // I12 (M115 C6): the two flags that decide how many combos and samples the
    // real run would measure. Same names and types as `AnalyzeOptions`, so the
    // CLI forwards one shape to both entry points.
    samples?: number;
    maxCombos?: number;
    // M115 C6 fix-up: curve mode measures one unit per scale point and the
    // combo path appends these same points as anchors, so the estimate prices
    // whichever list the real run would use.
    scalePoints?: number[];
  } = {},
): Promise<PropsExplanation> {
  const resolvedPath = path.resolve(componentPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Component file not found: ${componentPath}`);
  }

  const { projectRoot, relativeComponent } = resolveProjectPaths(resolvedPath);
  const componentName = detectComponentExport(resolvedPath, options.target).name;

  const warnings: string[] = [];

  // M91 (preact-app-F2): computed here, in the same order the full run
  // computes them, so a dry run's warnings are the same set a real run would
  // print for everything decidable without a browser. All four resolvers
  // are read-only filesystem probes (existing detection functions the full
  // run already calls) with no build/browser cost, so this function's own
  // "no side effect" contract (no harness dir, no dev server, no browser) is
  // unaffected.
  const framework = resolveFramework(
    options.framework ?? "auto",
    projectRoot,
    resolvedPath,
    (w) => warnings.push(w),
  );
  // M102 / I6: resolved before the CSS probe, and in the same order the full
  // run resolves them (resolveWrapPath then resolveCssFiles), so a wrapper's
  // own stylesheet imports are discoverable in both modes.
  const { wrapPath } = resolveWrapPath({}, projectRoot, framework, warnings);
  const resolvedCss = resolveCssFiles({}, projectRoot, warnings, {
    ...(wrapPath ? { wrapPath } : {}),
    measuredFile: resolvedPath,
  });
  // M100 (preact-app-F1): the real run formats this line the moment the CSS
  // decision is made (analyze.ts's `cssDecisionWarning`) and carries it
  // through every exit path including a crash; the dry run resolved the same
  // files and never said which ones it picked, so two runs that died at the
  // identical react-dom gate printed different warning sets.
  warnings.push(formatStylesheetsLine(buildCssReport(resolvedCss, projectRoot)));
  // M92/M95 (nuxt-ui-F2): the full run's harness build always calls this
  // (src/harness.ts:2464) and its TSCONFIG_EXTENDS_BROKEN_WARNING is what
  // connects a broken `extends` chain to the empty prop schema it causes; a
  // dry run never called it at all, so nuxt-ui's --explain-props reported "0
  // props" on every candidate with no cause named while the full run (once
  // it got far enough) correctly joined the two. extractPropsDetailed below
  // uses a separate, checker-only tsconfig read (src/prop-gen.ts) that never
  // saw this diagnostic either.
  // M100 (twenty-F1, dub-F3, nuxt-ui-F3): loadTsconfigAliases is now the first
  // step of this one probe, which is the whole pre-build half of buildAndServe
  // that needs nothing but the filesystem — the vite.config text parse, the
  // external-dependency scan (broken aliases, unbuilt workspace `dist/`
  // substitution, type-only packages), the Next shim inventory and the style
  // tooling check. All of it was unreachable from a dry run only because it
  // was nested inside the function that starts a server, so the cheap probe
  // said nothing about the fact that then killed the real run.
  // M117 C4: the same filter the real run applies to the same list, from the
  // same two reads, so a note the dry run prints is a note the real run prints.
  warnings.push(
    ...suppressHonoredPluginNote(
      collectStaticPreBuildWarnings(projectRoot, {
        componentPath: resolvedPath,
        ...(wrapPath ? { wrapPath } : {}),
        ...(options.noShims ? { noShims: true } : {}),
      }).warnings,
      projectRoot,
      options.noTransforms ? { noTransforms: true } : {},
    ),
  );

  // M78: the comment at this function's cli.ts call site has always promised
  // "before every check that exists to protect a measurement, because it
  // never starts one" — this call is what makes that true. Same gate order
  // buildAndServe uses: preflight's graph-walk hard-hits first (bypassable
  // via --no-preflight), then the always-on react-dom gate, at zero build
  // cost (no harness dir, no dev server), matching this function's own
  // "measures nothing" contract.
  // M110 A5 end-game (directus-NEW1): the real run walks a `.vue` graph with
  // the project's own SFC parser (see the `vueCompiler` argument at the run
  // path's own runPreflight call); the dry run walked it without one and so
  // stopped at the first SFC import. A refusal five files deeper was therefore
  // invisible here and fatal there. Same compiler, same edges, same decision.
  const vueCompiler = framework === "vue" ? await loadVueCompiler(projectRoot) : undefined;
  // Same gate the run path applies (M57): without the SFC parser the walk sees
  // no edge out of a `.vue` target at all, so predicting a clean run here while
  // the run refuses outright is the parity break this whole block closes.
  if (framework === "vue" && !vueCompiler && isVueFile(resolvedPath)) {
    throw new Error(VUE_COMPILER_MISSING(projectRoot));
  }
  const preflight = runPreflight({
    projectRoot,
    entries: [resolvedPath],
    componentName,
    ...(vueCompiler ? { vueCompiler } : {}),
  });
  // M91 (commerce-F3): folded in before the hard/soft handling below runs,
  // so a one-hop-composed async server component gates identically here and
  // in the full run.
  preflight.hard.push(...composedChildPreflightHits(resolvedPath, projectRoot));
  for (const hit of preflight.soft) warnings.push(NODE_BUILTIN_WARNING(hit));
  // M110 C4 (logto-F3): `runPreflight` returned `transforms` on this path all
  // along and only the run path read it, so the dry run stayed silent about
  // the lines the real run printed a minute later from the same files. I3's
  // one classifier, same order, same text.
  for (const { hit, availability } of classifyProjectTransformHits(
    projectRoot,
    preflight.transforms,
    { ...(options.noTransforms ? { noTransforms: true } : {}) },
  )) {
    warnings.push(PROJECT_TRANSFORM_WARNING(hit, availability));
  }
  if (preflight.hard.length > 0) {
    if (options.noPreflight) warnings.push(PREFLIGHT_BYPASSED_WARNING(preflight.hard));
    else throw new Error(preflightFailureMessage(preflight.hard));
  }
  if (rendererFor(resolvedPath) === "react") {
    const bundlerAlias = detectBundlerReactDomAlias(projectRoot);
    if (bundlerAlias) {
      warnings.push(BUNDLER_PREACT_ALIAS_WARNING(bundlerAlias.configFile, bundlerAlias.target));
    }
    // M91 (preact-app-F2): the alias warning above must be computed and
    // pushed before this call, not after — assertReactDomClient throws
    // before a dry run ever reaches a later check, so the old ordering
    // (assert first, alias second) meant the alias note was never seen
    // whenever the version gate itself also failed, exactly preact-app's
    // repro. Wrapped so the throw still carries every warning collected so
    // far, matching the full run's own accumulated-warnings behavior.
    try {
      // M100 / I2 (element-plus-F1): the Vue-project question before the
      // react-dom question, in the order Lane A installed on the real-run
      // path (src/harness.ts:2604-2608), so both modes fail a Vue
      // render-function `.tsx` for the reason that applies to it instead of
      // for a missing react-dom install it could never use.
      assertRendererSupported(resolvedPath, projectRoot);
      assertReactDomClient(projectRoot);
    } catch (err) {
      if (err instanceof Error) {
        throw new Error(err.message + formatAccumulatedWarnings(warnings), { cause: err });
      }
      throw err;
    }
  }

  const detail = await extractPropsDetailed(resolvedPath, {
    ...(options.target ? { target: options.target } : {}),
    // A sink, not stderr: a dry run prints its diagnostics in its own output.
    onWarning: () => {},
  });
  // M112 C1: the preset decides which extraction remedies still have a
  // subject, so it is detected and applied before any of them is pushed. The
  // old order pushed them three lines before the preset loaded, which made the
  // capped-extraction remedy stale by construction (logto-F4).
  let schemas = detail.schemas;
  const presetPath = detectPropPresets(resolvedPath);
  const presets = presetPath ? loadPropPresets(presetPath, projectRoot) : undefined;
  let appliedPropNames: string[] = [];
  let unknownPresetProps: string[] = [];
  if (presets) {
    const applied = applyPropPresets(schemas, presets);
    schemas = applied.schemas;
    appliedPropNames = applied.applied;
    unknownPresetProps = applied.unknown;
  }
  warnings.push(...remediesAfterPreset(detail.warnings, appliedPropNames, presets?.path));
  if (presets && unknownPresetProps.length > 0) {
    warnings.push(UNKNOWN_PRESET_PROPS_WARNING(presets.path, unknownPresetProps));
  }
  // M92 (element-plus-F3): same suppression as runComboMode -- a zero-prop
  // count `detail.warnings` already attributes to a Vue scope exclusion does
  // not also get the generic "extraction may have failed" text.
  // M114 C1 (react-spectrum-F3): a specifier that did not resolve is the whole
  // explanation of the zero count, so it replaces the generic text rather than
  // preceding it.
  const projectRel = (file: string): string =>
    toPosix(path.relative(projectRoot, file));
  if (detail.unresolvedReExport) {
    warnings.push(
      UNRESOLVED_RE_EXPORT_WARNING(
        projectRel(detail.unresolvedReExport.barrel),
        detail.unresolvedReExport.specifier,
      ),
    );
  }
  if (
    schemas.length === 0 &&
    !detail.unresolvedReExport &&
    !detail.warnings.some(explainsZeroPropCount)
  ) {
    warnings.push(ZERO_PROPS_WARNING);
  }

  // M110 C1: kept as records, not names, because `inferComposition` reads the
  // same shape the dispatcher hands it.
  const componentExports = isVueFile(resolvedPath) ? undefined : await extractExports(resolvedPath);
  const exports = componentExports ? componentExports.map((e) => e.name) : [componentName];
  const curveMatch = detectScalingProps(schemas)[0];
  // The fixture inputs the real run has before it dispatches: an explicit
  // --fixture, a target that is itself a fixture, or one sitting next to the
  // component. Kept as the path, not a boolean, so a dropped --matrix can name
  // the file that took precedence.
  // The sibling probe mirrors the dispatcher's own gate (`!fixturePath &&
  // !options.target`): with a --target the real run ignores a sibling
  // fixture entirely.
  const dryRunFixturePath = options.fixturePath
    ? path.resolve(options.fixturePath)
    : isFixturePath(resolvedPath)
      ? resolvedPath
      : options.target
        ? undefined
        : detectFixture(resolvedPath);
  const dryRunUsesFixture = dryRunFixturePath !== undefined;
  // M112 C2: the sibling that carries the preset name without the preset
  // shape, disclosed once by its path instead of dropped. Gated on the fixture
  // decision the real run makes (src/analyze.ts's `presetShapeWarning`): a
  // fixture owns its scene, so both modes stay silent about a preset-named
  // sibling there (M100 parity).
  const shapeDisclosure = dryRunUsesFixture
    ? undefined
    : presetShapeDisclosure(resolvedPath, projectRoot);
  if (shapeDisclosure) warnings.push(shapeDisclosure);
  const dryRunFixtureFile = dryRunFixturePath
    ? toPosix(path.relative(projectRoot, dryRunFixturePath))
    : undefined;
  const dryRunFixtureProvenance: FixtureProvenance = options.fixturePath
    ? "explicit-flag"
    : isFixturePath(resolvedPath)
      ? "fixture-input"
      : "sibling";

  // M110 C1 (supabase-F3, calcom-R1): the dispatcher's own gate, evaluated
  // here from the same filesystem inputs. `inferComposition` reads export
  // names and schemas only, so this costs a source parse, not a browser --
  // the old "composition needs a runtime" rationale was never true.
  let composition: { root: string; exportCount: number } | undefined;
  if (
    componentExports &&
    componentExports.length > 1 &&
    !dryRunUsesFixture &&
    !options.skipAutoCompose &&
    !options.target
  ) {
    const tree = inferComposition(componentExports, await extractAllProps(resolvedPath));
    if (tree) composition = { root: tree.root, exportCount: componentExports.length };
  }

  // M83 #8 (chakra-ui-F7): detectComponentExport resolving to the file's own
  // marked `export default` is correct by JS/TS export semantics, not a bug
  // (Chakra's own authoring choice) — no change to *which* export is picked.
  // Only the escape hatch was undisclosed: when the resolved export carries a
  // degenerate-flagged required prop (M60) and an unpicked export in the same
  // file has an all-non-degenerate schema, name it and its #ExportName
  // override.
  const altNote = await alternativeExportNote(resolvedPath, componentName, schemas, options.target);
  if (altNote) warnings.push(altNote);

  // M100 (element-plus-F4): the real dispatcher's own precedence, not two
  // independent booleans. A fixture (given or auto-detected next to the
  // component) makes the matrix branch unreachable exactly as it does in
  // analyze(), and since M110 C1 an auto-composed scene is read from the same
  // source parse the dispatcher uses.
  const predictedMode = predictMode({
    isolation: options.isolation !== undefined,
    // `resolveCurveMatch`'s own precedence: --no-curve suppresses it
    // entirely, an explicit --curve names the prop itself, otherwise
    // detection answers -- and a fixture or composed scene has no curve
    // (resolveCurveMatch returns undefined for both).
    curve:
      options.curveMode === false || dryRunUsesFixture || composition !== undefined
        ? false
        : options.curveMode !== undefined && options.curveMode !== true
          ? true
          : curveMatch !== undefined,
    matrixEligible: options.matrixMode !== false && !dryRunUsesFixture && composition === undefined,
    matrixRequested: options.matrixMode === true,
    matrixAutoActivates: shouldAutoActivateMatrix(schemas),
  });

  // M110 C3 (calcom-R1): the same two lines the dispatcher now pushes, from
  // the same two inputs. Restricted to a `combo` prediction because isolation
  // and curve return before the dispatcher's matrix branch is reached, and
  // curve carries its own suppressor.
  if (options.matrixMode === true && predictedMode === "combo") {
    if (composition) {
      warnings.push(MATRIX_SUPPRESSED_BY_COMPOSITION_WARNING(composition.root));
    } else if (dryRunFixturePath) {
      warnings.push(
        MATRIX_SUPPRESSED_BY_FIXTURE_WARNING(dryRunFixtureFile!, dryRunFixtureProvenance),
      );
    }
  }

  // M110 review: `resolveCurveMatch` warns whenever an explicit --curve meets
  // a scene that has no curve; the dry run now knows both of those scenes, so
  // it says the same line from the same two inputs.
  if (options.curveMode === true || typeof options.curveMode === "object") {
    if (dryRunUsesFixture) {
      warnings.push(CURVE_NOT_ACTIVATED_WARNING("the run measures a fixture file"));
    } else if (composition) {
      warnings.push(CURVE_NOT_ACTIVATED_WARNING("the run measures a composed scene"));
    }
  }

  // M115 C6: what the real run would cost. Filesystem reads only -- the units
  // the mode this same dry run predicts would measure, the samples that mode
  // allows, and this component's own recorded phases when a `--save-baseline`
  // run on this machine left some.
  const costEstimate = estimateExplainedRunCost({
    schemas,
    projectRoot,
    relativeComponent,
    usesFixture: dryRunUsesFixture,
    mode: predictedMode,
    ...(options.scalePoints ? { scalePoints: options.scalePoints } : {}),
    samples: options.samples,
    maxCombos: options.maxCombos,
  });

  return {
    componentPath,
    componentName,
    ...(options.target ? { target: options.target } : {}),
    // M114 review: the line belongs to the file the declaration was read from.
    // Pairing it with the barrel's path printed a file:line the barrel does not
    // contain; the re-export line below still names the barrel.
    ...(detail.targetLine !== undefined
      ? {
          bindingFile: projectRel(detail.targetFile ?? resolvedPath),
          bindingLine: detail.targetLine,
        }
      : {}),
    // M114 C1: only when the declaring module is a different file; a component
    // declared where it was measured has no re-export to disclose.
    ...(detail.targetFile !== undefined &&
    path.resolve(detail.targetFile) !== path.resolve(resolvedPath)
      ? {
          reExport: {
            barrel: projectRel(resolvedPath),
            module: projectRel(detail.targetFile),
          },
        }
      : {}),
    exports,
    props: schemas.map((s) => {
      const branches = collapsedUnionBranchesFor(s.name, detail.warnings);
      return {
        name: s.name,
        kind: s.kind,
        required: s.required,
        values: s.values,
        ...(branches ? { unionBranches: branches } : {}),
        // `defaultValue` is legitimately `false`/`0`/`""`, so presence is what
        // decides, never truthiness.
        ...("defaultValue" in s ? { defaultValue: s.defaultValue } : {}),
        ...(s.defaultSource ? { defaultSource: s.defaultSource } : {}),
        ...(s.degenerate ? { degenerate: s.degenerate } : {}),
      };
    }),
    ...(curveMatch
      ? { curve: { propName: curveMatch.schema.name, reason: curveMatch.reason } }
      : {}),
    // M83 #5: the same gating condition runComboMode's non-curve, non-fixture
    // branch uses, including the `!composed` half M110 C1 made visible here.
    scaleProbeWillRun:
      !isFixturePath(resolvedPath) && !curveMatch && composition === undefined,
    matrixWouldActivate: shouldAutoActivateMatrix(schemas),
    predictedMode,
    ...(options.matrixMode === false
      ? { matrixIneligibleReason: "no-matrix-flag" as const }
      : dryRunUsesFixture
        ? { matrixIneligibleReason: "fixture" as const }
        // M110 C2: reported only when the matrix would otherwise have run, so
        // a component that never qualified is not told it lost a race.
        : composition && (options.matrixMode === true || shouldAutoActivateMatrix(schemas))
          ? { matrixIneligibleReason: "composed" as const }
          : {}),
    ...(composition ? { composition } : {}),
    ...(dryRunFixtureFile ? { fixtureFile: dryRunFixtureFile } : {}),
    ...(options.curveMode === false && curveMatch !== undefined
      ? { curveSuppressedByFlag: true }
      : {}),
    ...(presets ? { presetPath: presets.path } : {}),
    costEstimate,
    // M117 C1: the dry run deduplicates its own list by the same rule, so the
    // parity the real run owes it (M100/M110) is parity of what a reader sees.
    warnings: dedupeWarnings(warnings),
  };
}

const EXPLAIN_VALUE_CAP = 4;

const EXPLAIN_VALUE_WIDTH = 40;

function explainValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "function") return "[Function]";
  // M92 (1.5d, heroui): a preset pool's non-literal entry (a function/JSX/
  // variable reference, which cannot cross the CDP boundary) is stored as a
  // PresetRef sentinel -- {__120fps_preset, index} -- resolved from the real
  // preset module only at render time inside the browser. A dry run has no
  // browser to resolve it against, so the real value genuinely is not known
  // here; the internal marker itself must never be the displayed value in
  // its place, matching the [Function] convention just above.
  if (isPresetRef(value)) return "[preset value]";
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > EXPLAIN_VALUE_WIDTH
    ? text.slice(0, EXPLAIN_VALUE_WIDTH - 1) + "…"
    : text;
}

// M100 (excalidraw-F4): `ConfirmDialog.size` printed `"small"` in the value
// column while the warning two lines below said the union has four shapes, so
// a reader of the table alone believed `"small"` was the only accepted value.
// The branch list lives in the warning the same extraction produced, and is
// read back here rather than re-derived, so the two cannot drift.
//
// Interface request (Lane B): the source of truth belongs on `PropSchema`
// (a `unionBranches?: string[]` beside `values`); this reads the disclosure
// M84 already emits so the table stops contradicting it today.
const COLLAPSED_UNION_WARNING = /^Warning: prop "([^"]+)".* is a union of \d+ different shapes \(([^)]*)\)/;

export function collapsedUnionBranchesFor(
  propName: string,
  warnings: string[],
): string[] | undefined {
  for (const warning of warnings) {
    const match = COLLAPSED_UNION_WARNING.exec(warning);
    if (match && match[1] === propName) {
      return match[2].split(" | ").map((b) => b.trim()).filter((b) => b.length > 0);
    }
  }
  return undefined;
}

// A quoted branch is a literal the run could synthesize; anything else is a
// whole type the collapse dropped. Both are named, and they are named
// differently, because they are different facts about the prop.
export function explainUnionBranches(branches: string[]): string {
  const literals = branches.filter((b) => /^["'`]/.test(b));
  const others = branches.filter((b) => !/^["'`]/.test(b));
  const shownLiterals = literals.slice(0, EXPLAIN_VALUE_CAP);
  const restCount = literals.length - shownLiterals.length;
  const parts: string[] = [];
  if (shownLiterals.length > 0) parts.push(shownLiterals.join(", "));
  if (restCount > 0) parts.push(`+${restCount} more`);
  const head = parts.join(", ");
  return others.length > 0 ? `${head || "(no literal values)"} (+ ${others.join(", ")})` : head;
}

function explainValues(values: unknown[]): string {
  if (values.length === 0) return "(no values)";
  const shown = values.slice(0, EXPLAIN_VALUE_CAP).map(explainValue).join(", ");
  const rest = values.length - Math.min(values.length, EXPLAIN_VALUE_CAP);
  return rest > 0 ? `${shown}, +${rest} more` : shown;
}

export function formatExplainProps(explained: PropsExplanation): string {
  const lines: string[] = [];
  lines.push(`Component: ${explained.componentName}`);
  lines.push(`  file:     ${explained.componentPath}`);
  if (explained.target) lines.push(`  target:   ${explained.target} (explicit #Export)`);
  lines.push(
    explained.bindingLine !== undefined
      ? `  binding:  ${explained.bindingFile}:${explained.bindingLine}`
      : "  binding:  no component declaration (props read from the file itself)",
  );
  // M114 C1: beside the binding, because it is the reason the binding names a
  // file the reader did not pass.
  if (explained.reExport) {
    lines.push(
      `  ${RE_EXPORT_MEASURED_DISCLOSURE(explained.reExport.barrel, explained.reExport.module)}`,
    );
  }
  lines.push(
    `  exports:  ${explained.exports.length > 0 ? explained.exports.join(", ") : "(none)"}`,
  );
  if (explained.presetPath) lines.push(`  presets:  ${explained.presetPath}`);

  lines.push("");
  lines.push(`Props (${explained.props.length}):`);
  if (explained.props.length === 0) {
    lines.push("  (none extracted)");
  } else {
    const nameWidth = Math.max(...explained.props.map((p) => p.name.length));
    const kindWidth = Math.max(...explained.props.map((p) => p.kind.length));
    // M103 / I8 (calcom-F2): the column appears whenever any prop declares a
    // default, and the header names it so a blank cell reads as "no default"
    // rather than as a missing number.
    const anyDefault = explained.props.some((p) => p.defaultValue !== undefined);
    const defaultWidth = anyDefault
      ? Math.max(
          "default".length,
          ...explained.props.map((p) =>
            p.defaultValue === undefined ? 0 : explainValue(p.defaultValue).length,
          ),
        )
      : 0;
    if (anyDefault) {
      lines.push(
        `  ${"prop".padEnd(nameWidth)}  ${"type".padEnd(kindWidth)}  ${"required".padEnd(8)}  ` +
        `${"default".padEnd(defaultWidth)}  value`,
      );
    }
    for (const prop of explained.props) {
      const required = prop.required ? "required" : "optional";
      const defaultColumn = anyDefault
        ? `${(prop.defaultValue === undefined ? "" : explainValue(prop.defaultValue)).padEnd(defaultWidth)}  `
        : "";
      // M100 (excalidraw-F4): a collapsed union renders its whole branch list,
      // so the row and the warning below describe the same prop.
      const valueColumn = prop.unionBranches
        ? explainUnionBranches(prop.unionBranches)
        : explainValues(prop.values);
      let line = `  ${prop.name.padEnd(nameWidth)}  ${prop.kind.padEnd(kindWidth)}  ${required}  ${defaultColumn}${valueColumn}`;
      if (prop.degenerate) line += `  [degenerate: ${prop.degenerate}]`;
      lines.push(line);
    }
  }

  lines.push("");
  // M110 C1 (supabase-F3, calcom-R1): before the mode lines, because which
  // scene the run builds is what makes the matrix branch reachable at all.
  lines.push(
    explained.composition
      ? `Composition:  would auto-compose from ${explained.composition.root} ` +
        `(${explained.composition.exportCount} exports)`
      : explained.fixtureFile
        ? `Composition:  would measure the scene in ${explained.fixtureFile}`
        : `Composition:  would measure ${explained.componentName} alone`,
  );
  lines.push(
    explained.curveSuppressedByFlag
      ? "Curve mode:   would not activate: --no-curve, though this component has a scaling prop"
      // M110 review: `resolveCurveMatch` returns undefined for a composed
      // scene, so a scaling prop on the root does not make curve mode run.
      : explained.composition && explained.curve
        ? "Curve mode:   would not activate: an auto-composed scene supplies the props"
      : explained.curve
        ? `Curve mode:   would activate on ${explained.curve.propName} (${explained.curve.reason})`
        : "Curve mode:   would not activate: no array or numeric scaling prop",
  );
  // M83 #5 (base-ui-F6): a separate mechanism from curve mode above — the M61
  // sibling-copies scale probe runs unconditionally on a non-fixture target
  // whenever curve mode does not, regardless of whether the component has
  // any array/numeric prop at all.
  if (explained.scaleProbeWillRun) {
    lines.push(
      "Scale probe:  would still run N=1/5/20/50 synthetic copies and report a growth class, " +
      "independent of curve mode",
    );
  }
  // M100 (element-plus-F4): "would auto-activate" was printed from the matrix
  // predicate alone, while the real dispatcher returns at curve before the
  // matrix branch is reached — badge.vue's dry run promised a matrix the real
  // run never ran. The predicate's answer is still shown; what it loses to is
  // now shown with it.
  lines.push(
    // M110 C2: an explicit --matrix reaches this branch over a component whose
    // own predicate never matched, so the composed answer is given before the
    // predicate's, and "would auto-activate" can never print for a scene the
    // dispatcher composes.
    // The predicate's own answer decides the first clause: an explicit
    // --matrix reaches "composed" over a component whose predicate never
    // matched, and saying "predicate matches" there would be false (M92).
    explained.matrixIneligibleReason === "composed" && explained.composition
      ? (explained.matrixWouldActivate
          ? "Matrix mode:  predicate matches, but an auto-composed scene supplies the props, so " +
            "this run would measure that scene's single combo"
          : "Matrix mode:  --matrix was passed, but an auto-composed scene supplies the props, so " +
            "this run would measure that scene's single combo") +
        ` (auto-composed from ${explained.composition.root})`
    : explained.matrixWouldActivate
      ? explained.predictedMode === "matrix"
        ? "Matrix mode:  would auto-activate"
        // C-6: combo mode takes no precedence over matrix -- when the
        // prediction is `combo` the matrix branch was *ineligible*, which on a
        // dry run means a fixture (given or sitting next to the component)
        // supplies the props. Naming precedence there would be false.
        : explained.matrixIneligibleReason === "no-matrix-flag"
          ? "Matrix mode:  predicate matches, but --no-matrix was passed, so this run would measure prop combos"
        : explained.matrixIneligibleReason === "fixture"
          ? "Matrix mode:  predicate matches, but a fixture supplies the props, so this run would measure the fixture's single combo"
        : explained.predictedMode === "combo"
          ? "Matrix mode:  predicate matches, but this run would measure prop combos"
          : `Matrix mode:  predicate matches, but ${explained.predictedMode} mode takes precedence and is what this run would use`
      : "Matrix mode:  would not auto-activate",
  );

  // M115 C6: an estimate, said in that word, with the units it multiplied and
  // where the per-phase numbers came from. Nothing was measured to produce it.
  const estimate = explained.costEstimate;
  if (estimate) {
    lines.push(
      `Estimated real run: ~${formatPhaseDuration(estimate.estimatedMs)} ` +
      `(${estimate.combos} combos x ${estimate.samples} samples; ` +
      (estimate.source === "baseline"
        ? "phase timings from 120fps-baseline.json)"
        : "defaults: no phase timings recorded for this component yet)"),
    );
  }

  if (explained.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of explained.warnings) lines.push(`  ${warning}`);
  }

  lines.push("");
  lines.push("Dry run: nothing was measured, no report was written.");
  // M100: M91's MUST NOT, rescoped. Everything decidable from the filesystem
  // now prints in both modes; what is left needs the browser, and saying so in
  // one line is what keeps a clean dry run from reading as a promise.
  lines.push(DRY_RUN_RUNTIME_ONLY_NOTE);
  return lines.join("\n");
}
