import path from "node:path";
import {
  retagPhaseError,
  measuredOnly,
  measureMount,
  measureRerender,
  type MountResult,
  type RerenderResult,
} from "../../browser/index.js";
import {
  type PropSchema,
  generateDeltaPairs,
  generatePropMatrix,
  selectMatrixCombos,
  matrixAxesFor,
  matrixHeldAbsentProps,
  countDeltaPairSpace,
  DEFAULT_MEASURED_COMBOS,
  type DeltaPair,
  type PropCombination,
} from "../../props/index.js";
import {
  EXPLORE_BUDGET_WARNING,
  hasReactWarning,
  explore,
  exploreRunOptions,
  restoreComboIndices,
} from "../../analysis/index.js";

// What one matrix cell may spend when the run names no budget of its own; the phase budget, when
// the run does name one, is divided across the cells instead.
export const MATRIX_CELL_WALL_CLOCK_MS = 30000;
import {
  attachWrapperReport,
  type PropDelta,
  type Report,
  buildMatrixReport,
  type MatrixAxis,
} from "../../report/index.js";
import { type AnalyzeOptions, writeReportJson } from "../analyze.js";
import { buildReport } from "../build-report.js";
import { type FixtureProvenance } from "../fixtures.js";
import {
  EFFECTIVE_SAMPLES_WARNING,
  type ModeContext,
  animatedIndices,
  collectReactOptimizations,
  computeEffectiveSamples,
  detectComponentName,
} from "../modes/context.js";

export const MATRIX_CELL_CAP_WARNING = (kept: number, total: number): string =>
  `measured ${kept} of ${total} matrix cells; ${total - kept} were dropped to bound the run. ` +
  `Raise it with --max-combos <n>.`;

export const DELTA_PAIR_CAP_WARNING = (measured: number, total: number): string =>
  `measured ${measured} of ${total} possible delta pairs; ${total - measured} were dropped to bound the run.`;

export const MATRIX_PAIRWISE_COVER_WARNING = (covered: number, full: number): string =>
  `matrix has ${full} possible cells; measured ${covered} via pairwise cover (every value pair, not every ` +
  `cell): coverage is not exhaustive.`;

export const MATRIX_AUTO_ACTIVATED_NOTICE = (cellCount: number): string =>
  `Matrix mode auto-activated: measuring all ${cellCount} prop combinations, which multiplies run time ` +
  `roughly ${cellCount}x versus a single combo. Use --no-matrix to disable.`;

// A run is one whole-run mode or the other: an explicit --matrix must not lose in silence.
export const MATRIX_SUPPRESSED_BY_CURVE_WARNING = (propName: string): string =>
  `--matrix did not activate: curve mode auto-activated on ${propName} first, and a run is one ` +
  "whole-run mode or the other. Re-run with --no-curve to force matrix instead.";

// A composed scene also makes the matrix unreachable; say so instead of falling through silently.
export const MATRIX_SUPPRESSED_BY_COMPOSITION_WARNING = (rootName: string): string =>
  `--matrix did not activate: an auto-composed scene rooted at ${rootName} supplies the props, and ` +
  "a composed scene measures one combo. Re-run with --no-auto-compose to force matrix instead.";

export const MATRIX_SUPPRESSED_BY_FIXTURE_WARNING = (
  fixtureFile: string,
  provenance: FixtureProvenance = "sibling",
): string =>
  `--matrix did not activate: the fixture ${fixtureFile} supplies the props, and a fixture measures ` +
  "one combo. " +
  (provenance === "sibling"
    ? "Re-run with <file>#Export to name one export and force matrix instead."
    : provenance === "explicit-flag"
      ? "Re-run against the component file without --fixture to force matrix instead."
      : "Re-run against the component file, not this fixture, to force matrix instead.");

// An explicit --matrix bypasses shouldAutoActivateMatrix's 2-axis floor; no-axis runs land here.
export const MATRIX_NO_AXES_WARNING =
  "matrix mode found no boolean or small-union prop to cross: the single cell shown is the anchor " +
  "combo, not a real matrix. Re-run --explain-props to see why no prop qualified as an axis.";

// The matrix path returns before the baseline workflow runs, so every baseline flag is a no-op.
export const MATRIX_BASELINE_WARNING =
  "matrix runs do not participate in baselines: --save-baseline stores nothing and " +
  "--check/--budget compare nothing. Re-run with --no-matrix to save or check a baseline " +
  "for this component.";

// --no-baseline suppresses the comparison only, so a save still counts.
export function baselineWorkflowRequested(
  options: Pick<AnalyzeOptions, "saveBaseline" | "check" | "noBaseline">,
): boolean {
  if (options.saveBaseline) return true;
  return !!options.check && !options.noBaseline;
}

export async function runMatrixMode(ctx: ModeContext, matrixAutoActivated: boolean): Promise<Report> {
  const { options, harness, samples, cpuThrottle, warmupRuns, pool, onWarning, runWarnings, machine, calibration, thresholds, explicitThresholds } = ctx;
  const schemas = await ctx.getSchemas();
  let matrixCombos = generatePropMatrix(schemas);
  // Axes come from the same schemas the cells did, so the header cannot describe a different set.
  const matrixAxes: MatrixAxis[] = matrixAxesFor(schemas).map((axis) => ({
    propName: axis.propName,
    values: axis.values,
    ...(axis.declaredValues.length > axis.measuredValues.length
      ? { declaredValueCount: axis.declaredValues.length }
      : {}),
  }));

  // Independent of whichever fallback generatePropMatrix applied to fit MAX_MATRIX_CELLS.
  const fullMatrixCells = matrixAxes.reduce((acc, a) => acc * a.values.length, 1);
  if (fullMatrixCells > matrixCombos.length) {
    runWarnings.push(MATRIX_PAIRWISE_COVER_WARNING(matrixCombos.length, fullMatrixCells));
  }

  // Without this the run prints an unexplained "Prop Matrix ()" header.
  if (matrixAxes.length === 0) {
    runWarnings.push(MATRIX_NO_AXES_WARNING);
  }

  // --max-combos bounds matrix cells too, keeping the base cell and single-axis deviations first.
  const matrixComboCap = options.maxCombos ?? DEFAULT_MEASURED_COMBOS;
  if (matrixCombos.length > matrixComboCap) {
    const keptIndices = selectMatrixCombos(matrixCombos, matrixAxes, matrixComboCap);
    runWarnings.push(MATRIX_CELL_CAP_WARNING(keptIndices.length, matrixCombos.length));
    matrixCombos = keptIndices.map((i) => matrixCombos[i]);
  }

  if (baselineWorkflowRequested(options)) {
    runWarnings.push(MATRIX_BASELINE_WARNING);
  }

  // Printed before measurement, so the reader learns the run multiplies; --ci stays JSON-only.
  if (matrixAutoActivated && !options.ci) {
    process.stdout.write(MATRIX_AUTO_ACTIVATED_NOTICE(matrixCombos.length) + "\n");
  }

  // The same throttle the plain-combo path applies; a forced --matrix must not escape it.
  const matrixEffectiveSamples = computeEffectiveSamples(matrixCombos.length, samples);
  if (matrixEffectiveSamples < samples) {
    runWarnings.push(
      EFFECTIVE_SAMPLES_WARNING(matrixEffectiveSamples, samples, matrixCombos.length),
    );
  }

  ctx.progress(`mount: ${matrixCombos.length} matrix cells`);
  const matrixMounts = await measureMount(harness, {
    samples: matrixEffectiveSamples,
    cpuThrottle,
    warmupRuns,
    combos: matrixCombos,
    pool,
    onWarning,
  });
  ctx.progress(`rerender: ${matrixCombos.length} matrix cells`);
  const matrixRerenders = await measureRerender(harness, {
    samples: matrixEffectiveSamples,
    cpuThrottle,
    warmupRuns,
    combos: matrixCombos,
    animatedComboIndices: animatedIndices(matrixMounts),
    pool,
    onWarning,
  });

  const sortedMounts = [...matrixMounts].sort((a, b) => b.mount.median - a.mount.median);
  const hotIndices = sortedMounts.slice(0, 5).map((m) => m.comboIndex);
  const hotCombos = hotIndices.map((i) => matrixCombos[i]);
  const exploreBounds = exploreRunOptions(
    options,
    hotCombos.length,
    hotCombos.length * MATRIX_CELL_WALL_CLOCK_MS,
  );
  if (hotCombos.length > 0) {
    ctx.progress(
      `explore: ${hotCombos.length} hottest cells, budget ` +
        `${Math.round(exploreBounds.maxWallClockMs / 1000)}s${hotCombos.length > 1 ? " each" : ""}`,
    );
  }
  const rawExplores = hotCombos.length > 0
    ? await explore(harness, {
        samples: Math.min(samples, 5),
        cpuThrottle,
        warmupRuns,
        seed: ctx.seed,
        combos: hotCombos,
        ...exploreBounds,
        pool,
        onWarning,
      })
    : [];
  if (rawExplores.length < hotCombos.length) {
    runWarnings.push(EXPLORE_BUDGET_WARNING(rawExplores.length, hotCombos.length, "matrix cells"));
  }
  const matrixExplores = restoreComboIndices(rawExplores, hotIndices);

  let matrixDeltas: PropDelta[] | undefined;
  if (!options.skipDeltas && schemas.length > 0) {
    const deltaPairs = generateDeltaPairs(schemas);
    const totalDeltaPairs = countDeltaPairSpace(schemas);
    if (totalDeltaPairs > deltaPairs.length) {
      runWarnings.push(DELTA_PAIR_CAP_WARNING(deltaPairs.length, totalDeltaPairs));
    }
    const measured = new Map<string, { mount: MountResult; rerender?: RerenderResult }>();
    const measuredMatrixRerenders = measuredOnly(matrixRerenders);
    for (const m of measuredOnly(matrixMounts)) {
      measured.set(JSON.stringify(m.props), { mount: m, rerender: measuredMatrixRerenders.find((r) => r.comboIndex === m.comboIndex) });
    }
    const missingPairs = deltaPairs.filter((p) => !measured.has(JSON.stringify(p.baseCombo)) || !measured.has(JSON.stringify(p.flipCombo)));
    if (missingPairs.length > 0) {
      const missingCombos = [...new Set(missingPairs.flatMap((p) => [JSON.stringify(p.baseCombo), JSON.stringify(p.flipCombo)]))].filter((k) => !measured.has(k)).map((k) => JSON.parse(k) as PropCombination);
      if (missingCombos.length > 0) {
        // Same effective count as the sweep: full N would merge a differently-estimated number.
        const extraMounts = await measureMount(harness, { samples: matrixEffectiveSamples, cpuThrottle, warmupRuns, combos: missingCombos, pool });
        const extraRerenders = await measureRerender(harness, { samples: matrixEffectiveSamples, cpuThrottle, warmupRuns, combos: missingCombos, animatedComboIndices: animatedIndices(extraMounts), pool });
        const measuredExtraRerenders = measuredOnly(extraRerenders);
        for (const m of measuredOnly(extraMounts)) measured.set(JSON.stringify(m.props), { mount: m, rerender: measuredExtraRerenders.find((r) => r.comboIndex === m.comboIndex) });
      }
    }
    const matrixMedians = new Map(
      [...measured].map(([key, cell]) => [
        key,
        { mount: cell.mount.mount.median, rerender: cell.rerender?.stable.median },
      ]),
    );
    matrixDeltas = propDeltasFromMeasured(deltaPairs, matrixMedians);
  }

  const heapDeltas = matrixMounts.map((m) => m.heapDelta ?? 0);
  const componentName = detectComponentName(ctx.metadataPath, ctx.options.target);
  const report = buildReport({
    componentPath: ctx.componentPath,
    componentName,
    machine,
    calibration,
    mounts: matrixMounts,
    explores: matrixExplores,
    heapDeltas,
    thresholds,
    phaseClock: ctx.phaseClock,
    rerenders: matrixRerenders,
    flatThresholds: options.flatThresholds,
    explicitThresholds,
    skipAttribution: options.skipAttribution,
    ...(schemas ? { schemas } : {}),
    ...(ctx.disclosureReason !== undefined ? { disclosureReason: ctx.disclosureReason } : {}),
    ...(harness.nextJsShims && harness.nextJsShims.length > 0 ? { nextJsShims: harness.nextJsShims } : {}),
  });

  // Before buildMatrixReport: a cell projects the combo's verdict, and a react warning demotes it.
  const matrixReact = await collectReactOptimizations(ctx, matrixCombos, schemas, report);
  for (const combo of report.combos) {
    const opts = matrixReact.get(combo.comboIndex);
    if (!opts) continue;
    combo.reactOptimizations = opts;
    if (combo.verdict === "pass" && hasReactWarning(opts)) combo.verdict = "warn";
  }

  report.matrixReport = buildMatrixReport({
    axes: matrixAxes,
    // Which non-axis props no cell carries.
    heldAbsentProps: matrixHeldAbsentProps(schemas),
    combos: report.combos,
    propDeltas: matrixDeltas,
  });

  if (matrixDeltas) report.propDeltas = matrixDeltas;
  if (ctx.wrapper) attachWrapperReport(report, ctx.wrapper);
  ctx.attachHarnessContext(report);

  report.phaseTimings = ctx.phaseClock.timings();
  writeReportJson(report, options.jsonPath);

  return report;
}

// A pair needs both sides' timings; a side the pass never reached yields no delta, not 0.00 ms.
export function propDeltasFromMeasured(
  pairs: DeltaPair[],
  measured: Map<string, { mount: number; rerender?: number }>,
): PropDelta[] {
  return pairs.flatMap((pair) => {
    const base = measured.get(JSON.stringify(pair.baseCombo));
    const flip = measured.get(JSON.stringify(pair.flipCombo));
    if (!base || !flip) return [];
    if (base.rerender === undefined || flip.rerender === undefined) return [];
    return [{
      propName: pair.propName,
      baseValue: pair.baseValue,
      flipValue: pair.flipValue,
      mountDelta: flip.mount - base.mount,
      rerenderDelta: flip.rerender - base.rerender,
    }];
  });
}

export async function measureStandardPropDeltas(
  ctx: ModeContext,
  schemas: PropSchema[],
  mounts: MountResult[],
  rerenders: RerenderResult[],
  effectiveSamples: number,
): Promise<PropDelta[] | undefined> {
  const { harness, cpuThrottle, warmupRuns, pool, onWarning, runWarnings } = ctx;
  const pairs = generateDeltaPairs(schemas);
  const totalDeltaPairs = countDeltaPairSpace(schemas);
  if (totalDeltaPairs > pairs.length) {
    runWarnings.push(DELTA_PAIR_CAP_WARNING(pairs.length, totalDeltaPairs));
  }
  if (pairs.length === 0) return undefined;

  // The rerender pass can end before the mount pass does, so a mount-only combo is ordinary.
  const measured = new Map<string, { mount: number; rerender?: number }>();
  for (const m of measuredOnly(mounts)) {
    const key = JSON.stringify(m.props);
    measured.set(key, { mount: m.mount.median });
  }
  for (const r of measuredOnly(rerenders)) {
    const key = JSON.stringify(r.props);
    const existing = measured.get(key);
    if (existing) {
      existing.rerender = r.stable.median;
    }
  }

  // A combo the mount pass omitted (frame starvation, a wedged page) must not report a 0 ms delta.
  const needed: PropCombination[] = [];
  const requested = new Set<string>();
  for (const pair of pairs) {
    for (const combo of [pair.baseCombo, pair.flipCombo]) {
      const key = JSON.stringify(combo);
      if (!measured.has(key) && !requested.has(key)) {
        needed.push(combo);
        requested.add(key);
      }
    }
  }

  if (needed.length > 0) {
    // measureMount tags its throws "mount"; retag as "delta" so the hint names the flag that skips.
    const deltaPhaseContext = { phase: "delta" as const, component: path.basename(harness.componentPath) };
    let extraMounts: MountResult[];
    try {
      extraMounts = await measureMount(harness, {
        samples: effectiveSamples,
        cpuThrottle,
        warmupRuns,
        combos: needed,
        pool,
        onWarning,
      });
    } catch (err) {
      throw retagPhaseError(err, deltaPhaseContext);
    }
    let extraRerenders: RerenderResult[];
    try {
      extraRerenders = await measureRerender(harness, {
        samples: effectiveSamples,
        cpuThrottle,
        warmupRuns,
        combos: needed,
        animatedComboIndices: animatedIndices(extraMounts),
        pool,
        onWarning,
      });
    } catch (err) {
      throw retagPhaseError(err, deltaPhaseContext);
    }
    for (const m of measuredOnly(extraMounts)) {
      measured.set(JSON.stringify(m.props), { mount: m.mount.median });
    }
    for (const r of measuredOnly(extraRerenders)) {
      const key = JSON.stringify(r.props);
      const existing = measured.get(key);
      if (existing) {
        existing.rerender = r.stable.median;
      }
    }
  }

  const propDeltas = propDeltasFromMeasured(pairs, measured);
  if (propDeltas.length === 0) return undefined;
  propDeltas.sort((a, b) => Math.abs(b.mountDelta) - Math.abs(a.mountDelta));
  return propDeltas;
}
