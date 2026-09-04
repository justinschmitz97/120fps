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

export interface ExplainedProp {
  name: string;
  kind: PropSchema["kind"];
  required: boolean;
  values: unknown[];
  degenerate?: string;
  // Every branch of a union the extractor collapsed to one measurable kind,
  // exactly as the collapsed-union warning lists them (`number | "small" |
  // "regular" | "wide"`). The value column renders from this so the table
  // and the warning cannot disagree; `values` still holds only what the run
  // would actually synthesize.
  unionBranches?: string[];
  // The value the component itself falls back to when the prop is omitted,
  // and where that was read from.
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
  // The measured file re-exports the component another module declares,
  // and the props below are that module's. Both paths, posix, relative to
  // the project root.
  reExport?: { barrel: string; module: string };
  exports: string[];
  props: ExplainedProp[];
  curve?: { propName: string; reason: string };
  matrixWouldActivate: boolean;
  // The "Curve mode: would (not) activate" line only predicts
  // detectScalingProps's whole-run auto-activation. The sibling-copies
  // scale probe is a separate, unconditional mechanism appended to every
  // default combo-mode run for a non-fixture target with no curve match —
  // this predicts *that*, so the dry run's stated mode matches what a real
  // run on the same target would actually do.
  scaleProbeWillRun: boolean;
  // Which mode the real dispatcher would pick for this component, through
  // the shared `predictMode`. `matrixWouldActivate` keeps its own narrower
  // meaning (the matrix predicate is satisfied) and stops being what gets
  // printed as a prediction.
  predictedMode: PredictedMode;
  // Why the matrix branch was unreachable, when it was. "combo" alone
  // cannot say, and the readings need different sentences: a flag the user
  // typed, a fixture that owns the props, or a composed scene that does.
  matrixIneligibleReason?: "no-matrix-flag" | "fixture" | "composed";
  // The dispatcher's own composition answer, decided from export names and
  // schemas. Absent when the run would measure the bound export alone.
  composition?: { root: string; exportCount: number };
  // The fixture that would supply the scene (projectRoot-relative posix
  // path), so the composition line does not claim the component would be
  // measured alone when a fixture owns the render.
  fixtureFile?: string;
  // Set when a scaling prop was detected and `--no-curve` suppressed it, so
  // "would not activate: no array or numeric scaling prop" is not printed over
  // a component that has one.
  curveSuppressedByFlag?: boolean;
  presetPath?: string;
  // What the real run this dry run predicts is about to cost.
  costEstimate?: RunCostEstimate;
  warnings: string[];
}

// The same resolution the pipeline performs, stopped before its first side
// effect: no harness directory, no dev server, no browser, no report file.
export async function explainProps(
  componentPath: string,
  // Forwarded to resolveFramework below so
  // FRAMEWORK_FLAG_NO_MOUNT_EFFECT_WARNING can fire in a dry run exactly as
  // it does in the real run.
  options: {
    target?: string;
    noPreflight?: boolean;
    framework?: "react" | "vue" | "vanilla" | "auto";
    // The four flags that decide which mode a real run takes. Without
    // them the dry run can only predict from its own detection, which
    // would disagree with an explicit flag the user passed. Same names and
    // types as `AnalyzeOptions`, so the CLI forwards one shape to both
    // entry points.
    curveMode?: boolean | { propName: string; propKind: "array" | "number" };
    matrixMode?: boolean;
    isolation?: { phases: string[]; memoryCycles?: number };
    fixturePath?: string;
    // The two remaining flags that change what the dispatcher decides from
    // disk. Same names and types as `AnalyzeOptions`, so the CLI forwards
    // one shape to both entry points.
    skipAutoCompose?: boolean;
    noTransforms?: boolean;
    // The static pre-build both modes read resolves the external-dependency
    // scan against the shim aliases, which `--no-shims` removes. Without
    // this flag a `--no-shims` real run could report a different unresolved
    // set than the dry run predicted from the same files.
    noShims?: boolean;
    // The two flags that decide how many combos and samples the real run
    // would measure. Same names and types as `AnalyzeOptions`, so the CLI
    // forwards one shape to both entry points.
    samples?: number;
    maxCombos?: number;
    // Curve mode measures one unit per scale point and the combo path
    // appends these same points as anchors, so the estimate prices
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

  // Computed here, in the same order the full run computes them, so a dry
  // run's warnings are the same set a real run would print for everything
  // decidable without a browser. All four resolvers
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
  // Resolved before the CSS probe, and in the same order the full run
  // resolves them (resolveWrapPath then resolveCssFiles), so a wrapper's
  // own stylesheet imports are discoverable in both modes.
  const { wrapPath } = resolveWrapPath({}, projectRoot, framework, warnings);
  const resolvedCss = resolveCssFiles({}, projectRoot, warnings, {
    ...(wrapPath ? { wrapPath } : {}),
    measuredFile: resolvedPath,
  });
  // The real run formats this line the moment the CSS decision is made
  // (phases.ts's `cssDecisionWarning`) and carries it through every exit
  // path including a crash, so the dry run must resolve the same files and
  // say which ones it picked too.
  warnings.push(formatStylesheetsLine(buildCssReport(resolvedCss, projectRoot)));
  // The full run's harness build always calls this (harness/prebuild.ts)
  // and its TSCONFIG_EXTENDS_BROKEN_WARNING is what connects a broken
  // `extends` chain to the empty prop schema it causes. extractPropsDetailed
  // below uses a separate, checker-only tsconfig read
  // (project/compiler-options.ts) that never sees this diagnostic either.
  // loadTsconfigAliases is the first step of this one probe, which is the
  // whole pre-build half of buildAndServe that needs nothing but the
  // filesystem — the vite.config text parse, the external-dependency scan
  // (broken aliases, unbuilt workspace `dist/` substitution, type-only
  // packages), the Next shim inventory and the style tooling check.
  // The same filter the real run applies to the same list, from the
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

  // This call is what keeps the promise the cli/main.ts call site makes:
  // "before every check that exists to protect a measurement, because it
  // never starts one." Same gate order buildAndServe uses: preflight's
  // graph-walk hard-hits first (bypassable via --no-preflight), then the
  // always-on react-dom gate, at zero build cost (no harness dir, no dev
  // server), matching this function's own "measures nothing" contract.
  // The real run walks a `.vue` graph with the project's own SFC parser
  // (see the `vueCompiler` argument at the run path's own runPreflight
  // call); this call needs the same compiler so a refusal several files
  // deep is visible to the dry run too. Same compiler, same edges, same
  // decision.
  const vueCompiler = framework === "vue" ? await loadVueCompiler(projectRoot) : undefined;
  // Same gate the run path applies: without the SFC parser the walk sees
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
  // Folded in before the hard/soft handling below runs, so a
  // one-hop-composed async server component gates identically here and
  // in the full run.
  preflight.hard.push(...composedChildPreflightHits(resolvedPath, projectRoot));
  for (const hit of preflight.soft) warnings.push(NODE_BUILTIN_WARNING(hit));
  // `runPreflight` returns `transforms` on this path too, read here with the
  // same classifier, same order, same text the run path uses, so the dry
  // run and the real run cannot disagree about these lines.
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
    // The alias warning above must be computed and pushed before this
    // call, not after: assertReactDomClient throws before a dry run ever
    // reaches a later check, so an alias note pushed afterward would never
    // be seen whenever the version gate itself also failed. Wrapped so the
    // throw still carries every warning collected so far, matching the
    // full run's own accumulated-warnings behavior.
    try {
      // The Vue-project question before the react-dom question, in the
      // same order the real-run path calls them (harness/build.ts), so
      // both modes fail a Vue render-function `.tsx` for the reason that
      // applies to it instead of for a missing react-dom install it could
      // never use.
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
  // The preset decides which extraction remedies still have a subject, so
  // it is detected and applied before any of them is pushed.
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
  // Same suppression as runComboMode -- a zero-prop count `detail.warnings`
  // already attributes to a Vue scope exclusion does not also get the
  // generic "extraction may have failed" text. A specifier that did not
  // resolve is the whole explanation of the zero count, so it replaces the
  // generic text rather than preceding it.
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

  // Kept as records, not names, because `inferComposition` reads the
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
  // The sibling that carries the preset name without the preset shape,
  // disclosed once by its path instead of dropped. Gated on the fixture
  // decision the real run makes (pipeline/phases.ts's `presetShapeWarning`):
  // a fixture owns its scene, so both modes stay silent about a
  // preset-named sibling there.
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

  // The dispatcher's own gate, evaluated here from the same filesystem
  // inputs. `inferComposition` reads export names and schemas only, so
  // this costs a source parse, not a browser.
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

  // detectComponentExport resolving to the file's own marked `export
  // default` is correct by JS/TS export semantics, not a bug in the file's
  // own authoring choice: this never changes *which* export is picked. It
  // only surfaces the existing #ExportName escape hatch when the resolved
  // export carries a degenerate-flagged required prop and an unpicked
  // export in the same file has an all-non-degenerate schema.
  const altNote = await alternativeExportNote(resolvedPath, componentName, schemas, options.target);
  if (altNote) warnings.push(altNote);

  // The real dispatcher's own precedence, not two independent booleans. A
  // fixture (given or auto-detected next to the component) makes the
  // matrix branch unreachable exactly as it does in analyze(), and an
  // auto-composed scene is read from the same source parse the dispatcher
  // uses.
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

  // The same two lines the dispatcher pushes, from the same two inputs.
  // Restricted to a `combo` prediction because isolation and curve return
  // before the dispatcher's matrix branch is reached, and curve carries
  // its own suppressor.
  if (options.matrixMode === true && predictedMode === "combo") {
    if (composition) {
      warnings.push(MATRIX_SUPPRESSED_BY_COMPOSITION_WARNING(composition.root));
    } else if (dryRunFixturePath) {
      warnings.push(
        MATRIX_SUPPRESSED_BY_FIXTURE_WARNING(dryRunFixtureFile!, dryRunFixtureProvenance),
      );
    }
  }

  // `resolveCurveMatch` warns whenever an explicit --curve meets a scene
  // that has no curve; the dry run knows both of those scenes, so it says
  // the same line from the same two inputs.
  if (options.curveMode === true || typeof options.curveMode === "object") {
    if (dryRunUsesFixture) {
      warnings.push(CURVE_NOT_ACTIVATED_WARNING("the run measures a fixture file"));
    } else if (composition) {
      warnings.push(CURVE_NOT_ACTIVATED_WARNING("the run measures a composed scene"));
    }
  }

  // What the real run would cost. Filesystem reads only -- the units
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
    // The line belongs to the file the declaration was read from. Pairing
    // it with the barrel's path would print a file:line the barrel does
    // not contain; the re-export line below still names the barrel.
    ...(detail.targetLine !== undefined
      ? {
          bindingFile: projectRel(detail.targetFile ?? resolvedPath),
          bindingLine: detail.targetLine,
        }
      : {}),
    // Only when the declaring module is a different file; a component
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
    // The same gating condition runComboMode's non-curve, non-fixture branch
    // uses, including the `!composed` half.
    scaleProbeWillRun:
      !isFixturePath(resolvedPath) && !curveMatch && composition === undefined,
    matrixWouldActivate: shouldAutoActivateMatrix(schemas),
    predictedMode,
    ...(options.matrixMode === false
      ? { matrixIneligibleReason: "no-matrix-flag" as const }
      : dryRunUsesFixture
        ? { matrixIneligibleReason: "fixture" as const }
        // Reported only when the matrix would otherwise have run, so
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
    // The dry run deduplicates its own list by the same rule, so the
    // parity the real run owes it is parity of what a reader sees.
    warnings: dedupeWarnings(warnings),
  };
}

const EXPLAIN_VALUE_CAP = 4;

const EXPLAIN_VALUE_WIDTH = 40;

function explainValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "function") return "[Function]";
  // A preset pool's non-literal entry (a function/JSX/
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

// The value column would otherwise print only the one accepted value a
// collapsed union happened to synthesize, while the warning two lines below
// says the union has several shapes. The branch list lives in the warning
// the same extraction produced, and is read back here rather than
// re-derived, so the two cannot drift.
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
  // Beside the binding, because it is the reason the binding names a
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
    // The column appears whenever any prop declares a default, and the
    // header names it so a blank cell reads as "no default" rather than as
    // a missing number.
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
      // A collapsed union renders its whole branch list, so the row and
      // the warning below describe the same prop.
      const valueColumn = prop.unionBranches
        ? explainUnionBranches(prop.unionBranches)
        : explainValues(prop.values);
      let line = `  ${prop.name.padEnd(nameWidth)}  ${prop.kind.padEnd(kindWidth)}  ${required}  ${defaultColumn}${valueColumn}`;
      if (prop.degenerate) line += `  [degenerate: ${prop.degenerate}]`;
      lines.push(line);
    }
  }

  lines.push("");
  // Before the mode lines, because which scene the run builds is what
  // makes the matrix branch reachable at all.
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
      // `resolveCurveMatch` returns undefined for a composed
      // scene, so a scaling prop on the root does not make curve mode run.
      : explained.composition && explained.curve
        ? "Curve mode:   would not activate: an auto-composed scene supplies the props"
      : explained.curve
        ? `Curve mode:   would activate on ${explained.curve.propName} (${explained.curve.reason})`
        : "Curve mode:   would not activate: no array or numeric scaling prop",
  );
  // A separate mechanism from curve mode above — the sibling-copies scale
  // probe runs unconditionally on a non-fixture target whenever curve mode
  // does not, regardless of whether the component has any array/numeric
  // prop at all.
  if (explained.scaleProbeWillRun) {
    lines.push(
      "Scale probe:  would still run N=1/5/20/50 synthetic copies and report a growth class, " +
      "independent of curve mode",
    );
  }
  // "would auto-activate" cannot be printed from the matrix predicate
  // alone, because the real dispatcher returns at curve before the matrix
  // branch is reached. The predicate's answer is still shown; what it
  // loses to is shown alongside it.
  lines.push(
    // An explicit --matrix reaches this branch over a component whose own
    // predicate never matched, so the composed answer is given before the
    // predicate's, and "would auto-activate" can never print for a scene
    // the dispatcher composes: saying "predicate matches" there would be
    // false.
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
        // Combo mode takes no precedence over matrix -- when the
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

  // An estimate, said in that word, with the units it multiplied and
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
  // Everything decidable from the filesystem prints in both modes; what is
  // left needs the browser, and saying so in one line is what keeps a
  // clean dry run from reading as a promise.
  lines.push(DRY_RUN_RUNTIME_ONLY_NOTE);
  return lines.join("\n");
}
