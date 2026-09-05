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
  // Every branch of a collapsed union, so the value column and the warning cannot disagree.
  unionBranches?: string[];
  // The value the component falls back to when the prop is omitted.
  defaultValue?: unknown;
  defaultSource?: "destructuring" | "withDefaults" | "defaultProps";
}

export interface PropsExplanation {
  componentPath: string;
  componentName: string;
  target?: string;
  // Posix, projectRoot-relative, 1-based; absent for a Vue SFC and a file with no component.
  bindingFile?: string;
  bindingLine?: number;
  // The props below belong to the declaring module, not the measured file. Posix paths.
  reExport?: { barrel: string; module: string };
  exports: string[];
  props: ExplainedProp[];
  curve?: { propName: string; reason: string };
  matrixWouldActivate: boolean;
  // Decided apart from curve activation, so the curve line alone cannot predict this probe.
  scaleProbeWillRun: boolean;
  // What the dispatcher would pick; matrixWouldActivate keeps the narrower predicate meaning.
  predictedMode: PredictedMode;
  // Why the matrix branch was unreachable: "combo" alone cannot say, and each reading differs.
  matrixIneligibleReason?: "no-matrix-flag" | "fixture" | "composed";
  // Absent when the run would measure the bound export alone.
  composition?: { root: string; exportCount: number };
  // Posix, projectRoot-relative, so the composition line cannot claim a lone component.
  fixtureFile?: string;
  // Set when --no-curve suppressed a detected scaling prop, so "none found" is not printed.
  curveSuppressedByFlag?: boolean;
  presetPath?: string;
  // What the real run this dry run predicts is about to cost.
  costEstimate?: RunCostEstimate;
  warnings: string[];
}

// The pipeline's own resolution, stopped before its first side effect: no dir, server or browser.
export async function explainProps(
  componentPath: string,
  // Forwarded to resolveFramework, so FRAMEWORK_FLAG_NO_MOUNT_EFFECT_WARNING fires here too.
  options: {
    target?: string;
    noPreflight?: boolean;
    framework?: "react" | "vue" | "vanilla" | "auto";
    // AnalyzeOptions names and types, so the CLI forwards one shape to both entry points.
    curveMode?: boolean | { propName: string; propKind: "array" | "number" };
    matrixMode?: boolean;
    isolation?: { phases: string[]; memoryCycles?: number };
    fixturePath?: string;
    skipAutoCompose?: boolean;
    noTransforms?: boolean;
    // --no-shims removes the aliases the external-dependency scan resolves against.
    noShims?: boolean;
    samples?: number;
    maxCombos?: number;
    // Curve points and combo-path anchors are the same list, so the estimate prices either.
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

  // The full run's order, using the same read-only probes, so both modes warn identically.
  const framework = resolveFramework(
    options.framework ?? "auto",
    projectRoot,
    resolvedPath,
    (w) => warnings.push(w),
  );
  // Before the CSS probe, as the full run resolves it, so a wrapper's imports are discoverable.
  const { wrapPath } = resolveWrapPath({}, projectRoot, framework, warnings);
  const resolvedCss = resolveCssFiles({}, projectRoot, warnings, {
    ...(wrapPath ? { wrapPath } : {}),
    measuredFile: resolvedPath,
  });
  // The real run carries this line through every exit path, so the dry run states its pick too.
  warnings.push(formatStylesheetsLine(buildCssReport(resolvedCss, projectRoot)));
  // buildAndServe's filesystem-only pre-build; only this read reports a broken extends chain.
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

  // The same compiler the run path's runPreflight gets, so both walks see the same edges.
  const vueCompiler = framework === "vue" ? await loadVueCompiler(projectRoot) : undefined;
  // Without the SFC parser the walk sees no edge out of a .vue target, so a clean prediction lies.
  if (framework === "vue" && !vueCompiler && isVueFile(resolvedPath)) {
    throw new Error(VUE_COMPILER_MISSING(projectRoot));
  }
  const preflight = runPreflight({
    projectRoot,
    entries: [resolvedPath],
    componentName,
    ...(vueCompiler ? { vueCompiler } : {}),
  });
  // Folded in before the hard-hit check, so a composed child gates as it does in the full run.
  preflight.hard.push(...composedChildPreflightHits(resolvedPath, projectRoot));
  for (const hit of preflight.soft) warnings.push(NODE_BUILTIN_WARNING(hit));
  // The run path's classifier, order and text, so the two modes cannot disagree about these lines.
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
    // Wrapped so a throw still carries the alias note above, which the gate would otherwise hide.
    try {
      // Vue before react-dom, as harness/build.ts asks, so a Vue .tsx fails for its own reason.
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
  // The preset decides which remedies still have a subject, so it applies before any is pushed.
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
  // An unresolved specifier explains the zero count whole, so it replaces the generic text.
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

  // Records, not names: inferComposition reads the shape the dispatcher hands it.
  const componentExports = isVueFile(resolvedPath) ? undefined : await extractExports(resolvedPath);
  const exports = componentExports ? componentExports.map((e) => e.name) : [componentName];
  const curveMatch = detectScalingProps(schemas)[0];
  // A path, not a boolean, so a dropped --matrix can name the file that took precedence.
  const dryRunFixturePath = options.fixturePath
    ? path.resolve(options.fixturePath)
    : isFixturePath(resolvedPath)
      ? resolvedPath
      // The dispatcher gates its sibling probe on !options.target, so a --target ignores one.
      : options.target
        ? undefined
        : detectFixture(resolvedPath);
  const dryRunUsesFixture = dryRunFixturePath !== undefined;
  // Gated on the fixture decision the real run makes, so both modes stay silent together.
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

  // inferComposition reads export names and schemas, so this costs a source parse, not a browser.
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

  // Surfaces the #ExportName escape hatch; it never changes which export is picked.
  const altNote = await alternativeExportNote(resolvedPath, componentName, schemas, options.target);
  if (altNote) warnings.push(altNote);

  // The dispatcher's own precedence, not two independent booleans.
  const predictedMode = predictMode({
    isolation: options.isolation !== undefined,
    // resolveCurveMatch's precedence: --no-curve, then an explicit prop, then detection.
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

  // Only for a combo prediction: isolation and curve return earlier, and curve warns for itself.
  if (options.matrixMode === true && predictedMode === "combo") {
    if (composition) {
      warnings.push(MATRIX_SUPPRESSED_BY_COMPOSITION_WARNING(composition.root));
    } else if (dryRunFixturePath) {
      warnings.push(
        MATRIX_SUPPRESSED_BY_FIXTURE_WARNING(dryRunFixtureFile!, dryRunFixtureProvenance),
      );
    }
  }

  // resolveCurveMatch warns when an explicit --curve meets a scene that has none; so does this.
  if (options.curveMode === true || typeof options.curveMode === "object") {
    if (dryRunUsesFixture) {
      warnings.push(CURVE_NOT_ACTIVATED_WARNING("the run measures a fixture file"));
    } else if (composition) {
      warnings.push(CURVE_NOT_ACTIVATED_WARNING("the run measures a composed scene"));
    }
  }

  // Filesystem reads only: the units the predicted mode would measure, priced from recorded phases.
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
    // The line belongs to the declaring file; pairing it with the barrel would name no such line.
    ...(detail.targetLine !== undefined
      ? {
          bindingFile: projectRel(detail.targetFile ?? resolvedPath),
          bindingLine: detail.targetLine,
        }
      : {}),
    // A component declared where it was measured has no re-export to disclose.
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
        // defaultValue is legitimately false/0/"", so presence decides, never truthiness.
        ...("defaultValue" in s ? { defaultValue: s.defaultValue } : {}),
        ...(s.defaultSource ? { defaultSource: s.defaultSource } : {}),
        ...(s.degenerate ? { degenerate: s.degenerate } : {}),
      };
    }),
    ...(curveMatch
      ? { curve: { propName: curveMatch.schema.name, reason: curveMatch.reason } }
      : {}),
    // runComboMode's own gate for the non-curve, non-fixture branch, including the composed half.
    scaleProbeWillRun:
      !isFixturePath(resolvedPath) && !curveMatch && composition === undefined,
    matrixWouldActivate: shouldAutoActivateMatrix(schemas),
    predictedMode,
    ...(options.matrixMode === false
      ? { matrixIneligibleReason: "no-matrix-flag" as const }
      : dryRunUsesFixture
        ? { matrixIneligibleReason: "fixture" as const }
        // Reported only when the matrix would have run, so a component never in the race is silent.
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
    // Deduplicated by the real run's own rule, so parity is parity of what a reader sees.
    warnings: dedupeWarnings(warnings),
  };
}

const EXPLAIN_VALUE_CAP = 4;

const EXPLAIN_VALUE_WIDTH = 40;

function explainValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "function") return "[Function]";
  // A PresetRef resolves only in the browser, and the internal marker must never be displayed.
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

// Read back from the warning the same extraction produced, never re-derived, so the two agree.
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

// A quoted branch is a synthesizable literal; anything else is a whole type the collapse dropped.
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
  // Beside the binding, because it is why the binding names a file the reader did not pass.
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
    // The header names the column, so a blank cell reads as "no default", not a missing number.
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
      // A collapsed union renders its whole branch list, so the row and the warning agree.
      const valueColumn = prop.unionBranches
        ? explainUnionBranches(prop.unionBranches)
        : explainValues(prop.values);
      let line = `  ${prop.name.padEnd(nameWidth)}  ${prop.kind.padEnd(kindWidth)}  ${required}  ${defaultColumn}${valueColumn}`;
      if (prop.degenerate) line += `  [degenerate: ${prop.degenerate}]`;
      lines.push(line);
    }
  }

  lines.push("");
  // Before the mode lines: which scene the run builds is what makes the matrix branch reachable.
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
      // resolveCurveMatch returns undefined for a composed scene, whatever the root declares.
      : explained.composition && explained.curve
        ? "Curve mode:   would not activate: an auto-composed scene supplies the props"
      : explained.curve
        ? `Curve mode:   would activate on ${explained.curve.propName} (${explained.curve.reason})`
        : "Curve mode:   would not activate: no array or numeric scaling prop",
  );
  // A separate mechanism: the sibling-copies probe needs no array or numeric prop at all.
  if (explained.scaleProbeWillRun) {
    lines.push(
      "Scale probe:  would still run N=1/5/20/50 synthetic copies and report a growth class, " +
      "independent of curve mode",
    );
  }
  // The predicate alone cannot say "would auto-activate": the dispatcher returns at curve first.
  lines.push(
    // The composed answer comes first, so "predicate matches" never prints for a composed scene.
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
        // A combo prediction means the matrix branch was ineligible, so naming precedence lies.
        : explained.matrixIneligibleReason === "no-matrix-flag"
          ? "Matrix mode:  predicate matches, but --no-matrix was passed, so this run would measure prop combos"
        : explained.matrixIneligibleReason === "fixture"
          ? "Matrix mode:  predicate matches, but a fixture supplies the props, so this run would measure the fixture's single combo"
        : explained.predictedMode === "combo"
          ? "Matrix mode:  predicate matches, but this run would measure prop combos"
          : `Matrix mode:  predicate matches, but ${explained.predictedMode} mode takes precedence and is what this run would use`
      : "Matrix mode:  would not auto-activate",
  );

  // Named an estimate, with its units and their source: nothing was measured to produce it.
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
  // What is left needs the browser, and saying so keeps a clean dry run from reading as a promise.
  lines.push(DRY_RUN_RUNTIME_ONLY_NOTE);
  return lines.join("\n");
}
