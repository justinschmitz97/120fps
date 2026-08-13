import type { CDPSession, Page } from "playwright";
import type { HarnessResult } from "./harness.js";
import type { PropCombination } from "./prop-gen-values.js";
import type { BaselineMetrics } from "./budget.js";
import { buildTimingWithCV, type ComponentTier, type TimingWithCV } from "./report.js";
import {
  measureMount,
  measureRerender,
  mountAndTrace,
  mountAndWait,
  rerenderAndTrace,
  runHarnessSession,
  tryCollectGarbage,
  type BrowserPool,
  type MeasurementPacing,
} from "./measure.js";

export type IsolationPhase = "mount" | "rerender" | "unmount" | "memory" | "strictmode";

const ALL_PHASES: IsolationPhase[] = ["mount", "rerender", "unmount", "memory", "strictmode"];

// One more warmup cycle than the standard pass: an isolated phase has nothing
// else warming the same code path.
export const ISOLATION_WARMUP_RUNS = 3;
export const CHURN_CYCLES = 10;
export const DEFAULT_MEMORY_CYCLES = 20;
export const CHURN_DEGRADATION_LIMIT = 2.0;

// The memory phase warms up longer than the timing phases: its noise floor is
// one-time allocation, not JIT. Measured over 20 cycles at 4x throttle, growth
// for non-leaking components falls from ~14 KB/cycle at 3 warmup cycles to
// ~2.4 KB/cycle at 10, while a real leak stays at ~200 KB/cycle.
export const MEMORY_WARMUP_CYCLES = 10;

// Above the ~2.4 KB/cycle floor that survives warmup, with 3x headroom under it
// and 24x under the smallest leak observed. A 1 KB/cycle threshold sits inside
// the floor and calls every component a leak.
export const LEAK_BYTES_PER_CYCLE = 8192;

export const DEGENERATE_COMBO_WARNING =
  "Only one prop combination available; prop-change and churn measure stable rerenders.";
export const MEMORY_SKIPPED_WARNING =
  "Memory phase skipped: HeapProfiler.collectGarbage unavailable.";

export interface RerenderIsolation {
  stable: TimingWithCV;
  propChange: TimingWithCV;
  churn: TimingWithCV;
  churnDegradation: number;
}

export interface MemoryReport {
  cycles: number;
  heapBefore: number;
  heapAfter: number;
  heapGrowth: number;
  heapGrowthPerCycle: number;
  leakSuspected: boolean;
  gcPressure: number;
}

export interface StrictModeReport {
  normalMount: TimingWithCV;
  strictMount: TimingWithCV;
  overhead: number;
  doubleInvokeClean: boolean;
}

export interface IsolationReport {
  mount?: TimingWithCV;
  rerender?: RerenderIsolation;
  unmount?: TimingWithCV;
  memory?: MemoryReport;
  strictMode?: StrictModeReport;
}

export function parseIsolationPhases(raw: string): IsolationPhase[] {
  const parts = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);

  const seen = new Set<IsolationPhase>();
  for (const p of parts) {
    if (p === "all") {
      for (const phase of ALL_PHASES) seen.add(phase);
      continue;
    }
    if (!ALL_PHASES.includes(p as IsolationPhase)) {
      throw new Error(`Invalid isolation phase: "${p}". Valid phases: ${ALL_PHASES.join(", ")}, all`);
    }
    seen.add(p as IsolationPhase);
  }

  // Canonical order, so the same set of phases parses to the same list however
  // the user spelled it — `all,mount` and `memory,all` included.
  return ALL_PHASES.filter((p) => seen.has(p));
}

// measureChurn records one B rerender and one A rerender per cycle, so even
// and odd samples have different prop composition. Comparing across the mix
// measures the A/B gap; each parity is only ever compared against itself.
export function churnParitySeries(samples: number[]): number[][] {
  const even: number[] = [];
  const odd: number[] = [];
  samples.forEach((value, i) => (i % 2 === 0 ? even : odd).push(value));
  return [even, odd].filter((series) => series.length > 0);
}

function seriesDegradation(series: number[]): number | undefined {
  const edge = Math.min(3, Math.floor(series.length / 2));
  if (edge === 0) return undefined;
  const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
  const first = mean(series.slice(0, edge));
  if (first === 0) return undefined;
  return mean(series.slice(-edge)) / first;
}

// The worse parity: churn that degrades on one prop target is degradation,
// however steady the other one stays.
export function computeChurnDegradation(samples: number[]): number {
  const ratios = churnParitySeries(samples)
    .map(seriesDegradation)
    .filter((ratio): ratio is number => ratio !== undefined);
  return ratios.length === 0 ? 1.0 : Math.max(...ratios);
}

// Median and P95 describe the whole alternation (that is what a churn cycle
// costs), but dispersion is read inside a parity — across the mix it would
// report the A/B gap as instability.
export function buildChurnTiming(samples: number[]): TimingWithCV {
  const overall = buildTimingWithCV(samples);
  const parities = churnParitySeries(samples)
    .filter((series) => series.length > 1)
    .map(buildTimingWithCV);
  if (parities.length === 0) return overall;
  const worst = parities.reduce((a, b) => (b.cv > a.cv ? b : a));
  return { ...overall, cv: worst.cv, unstable: worst.unstable };
}

export function buildMemoryReport(input: {
  cycles: number;
  heapBefore: number;
  heapAfter: number;
  gcPressure: number;
}): MemoryReport {
  const heapGrowth = input.heapAfter - input.heapBefore;
  const heapGrowthPerCycle = input.cycles > 0 ? heapGrowth / input.cycles : 0;
  return {
    cycles: input.cycles,
    heapBefore: input.heapBefore,
    heapAfter: input.heapAfter,
    heapGrowth,
    heapGrowthPerCycle,
    leakSuspected: heapGrowthPerCycle > LEAK_BYTES_PER_CYCLE,
    gcPressure: input.gcPressure,
  };
}

export function buildStrictModeReport(
  normalSamples: number[],
  strictSamples: number[],
): StrictModeReport {
  const normalMount = buildTimingWithCV(normalSamples);
  const strictMount = buildTimingWithCV(strictSamples);
  const overhead = normalMount.median > 0
    ? ((strictMount.median - normalMount.median) / normalMount.median) * 100
    : 0;
  return {
    normalMount,
    strictMount,
    overhead,
    doubleInvokeClean: overhead <= 110,
  };
}

export function buildRerenderIsolation(
  stableSamples: number[],
  propChangeSamples: number[],
  churnSamples: number[],
): RerenderIsolation {
  return {
    stable: buildTimingWithCV(stableSamples),
    propChange: buildTimingWithCV(propChangeSamples),
    churn: buildChurnTiming(churnSamples),
    churnDegradation: computeChurnDegradation(churnSamples),
  };
}

export interface IsolationComboSelection {
  comboA: PropCombination;
  comboB: PropCombination;
  degenerate: boolean;
}

// Scale combos render N instances and are not a prop variation, so they are
// never the subject of an isolated phase.
export function selectIsolationCombos(combos: PropCombination[]): IsolationComboSelection {
  const usable = combos.filter((c) => !("__120fps_scaleN" in c));
  const comboA = usable[0] ?? {};
  const comboB = usable[1] ?? comboA;
  return { comboA, comboB, degenerate: usable.length < 2 };
}

async function unmountAndSettle(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__120fps.unmount());
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

async function readHeapUsage(cdp: CDPSession): Promise<number> {
  try {
    const usage = await cdp.send("Runtime.getHeapUsage" as any) as { usedSize: number };
    return usage.usedSize;
  } catch {
    return 0;
  }
}

export interface PhaseOptions {
  samples?: number;
  cpuThrottle?: number;
  warmupRuns?: number;
  // M35: "vsync" when the measured combo animates — driven frames would
  // change how much animation work lands in the traced windows.
  pacing?: MeasurementPacing;
  // M37: reuse pooled browsers (fresh context per phase session).
  pool?: BrowserPool;
}

// Untimed mount with propsA, then `cycles` traced A→B→A alternations. No GC
// between iterations: accumulated pressure is what churn measures.
export async function measureChurn(
  harness: HarnessResult,
  propsA: PropCombination,
  propsB: PropCombination,
  cycles: number,
  options: PhaseOptions = {},
): Promise<number[]> {
  const warmupRuns = options.warmupRuns ?? ISOLATION_WARMUP_RUNS;

  return runHarnessSession(
    harness,
    { label: "churn harness", cpuThrottle: options.cpuThrottle, ...(options.pacing ? { pacing: options.pacing } : {}), ...(options.pool ? { pool: options.pool } : {}) },
    async (page, cdp) => {
      await mountAndWait(page, propsA);
      for (let w = 0; w < warmupRuns; w++) {
        await rerenderAndTrace(page, cdp, propsA);
      }
      // Remount so the warmup's own accumulation is not part of cycle 1.
      await mountAndWait(page, propsA);

      const samples: number[] = [];
      for (let c = 0; c < cycles; c++) {
        samples.push(await rerenderAndTrace(page, cdp, propsB));
        samples.push(await rerenderAndTrace(page, cdp, propsA));
      }
      return samples;
    },
  );
}

const GC_PRESSURE_SAMPLE_INTERVAL = 5;
const GC_PRESSURE_BAND = 0.1;

export interface MemoryMeasurement {
  heapBefore: number;
  heapAfter: number;
  gcPressure: number;
}

// Undefined when the browser exposes no forced GC: heap deltas without it are
// dominated by uncollected garbage and would fabricate leaks.
export async function measureMemory(
  harness: HarnessResult,
  cycles: number,
  props: PropCombination,
  options: PhaseOptions = {},
): Promise<MemoryMeasurement | undefined> {
  const warmupRuns = options.warmupRuns ?? MEMORY_WARMUP_CYCLES;

  return runHarnessSession(
    harness,
    { label: "memory harness", cpuThrottle: options.cpuThrottle, ...(options.pacing ? { pacing: options.pacing } : {}), ...(options.pool ? { pool: options.pool } : {}) },
    async (page, cdp) => {
      for (let w = 0; w < warmupRuns; w++) {
        await mountAndWait(page, props);
        await unmountAndSettle(page);
      }

      if (!(await tryCollectGarbage(cdp))) return undefined;
      const heapBefore = await readHeapUsage(cdp);

      let gcPressure = 0;
      for (let c = 1; c <= cycles; c++) {
        await mountAndWait(page, props);
        await unmountAndSettle(page);
        if (c % GC_PRESSURE_SAMPLE_INTERVAL !== 0) continue;
        await tryCollectGarbage(cdp);
        const heap = await readHeapUsage(cdp);
        if (heapBefore > 0 && heap > heapBefore * (1 + GC_PRESSURE_BAND)) gcPressure++;
      }

      await tryCollectGarbage(cdp);
      return { heapBefore, heapAfter: await readHeapUsage(cdp), gcPressure };
    },
  );
}

async function sampleStrictPair(
  page: Page,
  cdp: CDPSession,
  props: PropCombination,
  warmupRuns: number,
  enter: (search?: string) => Promise<void>,
  search: string,
): Promise<number> {
  await enter(search);
  for (let w = 0; w < warmupRuns; w++) {
    await mountAndWait(page, props);
    await unmountAndSettle(page);
  }
  await tryCollectGarbage(cdp);
  return mountAndTrace(page, cdp, props);
}

// Interleaved normal/strict pairs so both series see the same machine
// conditions. Navigation and warmup sit outside the traced window.
export async function measureStrictMode(
  harness: HarnessResult,
  props: PropCombination,
  options: PhaseOptions = {},
): Promise<{ normal: number[]; strict: number[] }> {
  const sampleCount = options.samples ?? 10;
  const warmupRuns = options.warmupRuns ?? ISOLATION_WARMUP_RUNS;

  return runHarnessSession(
    harness,
    { label: "strictmode harness", cpuThrottle: options.cpuThrottle, ...(options.pacing ? { pacing: options.pacing } : {}), ...(options.pool ? { pool: options.pool } : {}) },
    async (page, cdp, enter) => {
      const normal: number[] = [];
      const strict: number[] = [];
      for (let s = 0; s < sampleCount; s++) {
        normal.push(await sampleStrictPair(page, cdp, props, warmupRuns, enter, ""));
        strict.push(await sampleStrictPair(page, cdp, props, warmupRuns, enter, "?strict=1"));
      }
      return { normal, strict };
    },
  );
}

export interface IsolationRunOptions {
  phases: IsolationPhase[];
  comboA: PropCombination;
  comboB: PropCombination;
  degenerate: boolean;
  samples: number;
  cpuThrottle: number;
  memoryCycles: number;
  // M37: reuse pooled browsers across all phase sessions.
  pool?: BrowserPool;
}

export interface IsolationRunResult {
  isolation: IsolationReport;
  domNodeCount?: number;
  hasAnimation?: boolean;
  warnings: string[];
}

export async function runIsolationPhases(
  harness: HarnessResult,
  options: IsolationRunOptions,
): Promise<IsolationRunResult> {
  const { phases, comboA, comboB, samples, cpuThrottle } = options;
  const isolation: IsolationReport = {};
  const warnings: string[] = [];
  let domNodeCount: number | undefined;
  let hasAnimation: boolean | undefined;

  if (phases.includes("mount") || phases.includes("unmount")) {
    const [result] = await measureMount(harness, {
      samples,
      cpuThrottle,
      warmupRuns: ISOLATION_WARMUP_RUNS,
      combos: [comboA],
      pool: options.pool,
    });
    if (result) {
      if (phases.includes("mount")) isolation.mount = buildTimingWithCV(result.mount.samples);
      if (phases.includes("unmount")) isolation.unmount = buildTimingWithCV(result.unmount.samples);
      domNodeCount = result.domNodeCount;
      hasAnimation = result.hasAnimation ?? false;
    }
  }

  // M35: animation status comes from the mount pass; when it did not run, the
  // status is unknown and phases default to driven pacing.
  const rerenderCombos = options.degenerate ? [comboA] : [comboA, comboB];
  const animatedPhase: Pick<PhaseOptions, "pacing" | "pool"> = {
    ...(hasAnimation ? { pacing: "vsync" as const } : {}),
    ...(options.pool ? { pool: options.pool } : {}),
  };

  if (phases.includes("rerender")) {
    if (options.degenerate) warnings.push(DEGENERATE_COMBO_WARNING);
    const results = await measureRerender(harness, {
      samples,
      cpuThrottle,
      warmupRuns: ISOLATION_WARMUP_RUNS,
      combos: rerenderCombos,
      pool: options.pool,
      ...(hasAnimation
        ? { animatedComboIndices: rerenderCombos.map((_, i) => i) }
        : {}),
    });
    const primary = results.find((r) => r.comboIndex === 0);
    const stable = primary?.stable.samples ?? [];
    const churn = await measureChurn(harness, comboA, comboB, CHURN_CYCLES, { cpuThrottle, ...animatedPhase });
    isolation.rerender = buildRerenderIsolation(stable, primary?.change?.samples ?? stable, churn);
  }

  if (phases.includes("memory")) {
    const measurement = await measureMemory(harness, options.memoryCycles, comboA, { cpuThrottle, ...animatedPhase });
    if (measurement) {
      isolation.memory = buildMemoryReport({ cycles: options.memoryCycles, ...measurement });
    } else {
      warnings.push(MEMORY_SKIPPED_WARNING);
    }
  }

  if (phases.includes("strictmode")) {
    const paired = await measureStrictMode(harness, comboA, { samples, cpuThrottle, ...animatedPhase });
    isolation.strictMode = buildStrictModeReport(paired.normal, paired.strict);
  }

  return { isolation, domNodeCount, hasAnimation, warnings };
}

// StrictMode double-invoke overhead is a development-mode property, so it warns
// through `doubleInvokeClean` and never fails the run.
export function computeIsolationVerdict(
  isolation: IsolationReport,
  mountBudgetMs: number | undefined,
): boolean {
  if (isolation.mount && mountBudgetMs !== undefined && isolation.mount.median > mountBudgetMs) {
    return false;
  }
  if (isolation.memory?.leakSuspected) return false;
  if (isolation.rerender && isolation.rerender.churnDegradation > CHURN_DEGRADATION_LIMIT) {
    return false;
  }
  return true;
}

// Phases that did not run record 0, which compareBaseline skips.
export function isolationBaselineMetrics(
  isolation: IsolationReport,
  tier: ComponentTier,
  domNodeCount: number,
): BaselineMetrics {
  const unstable = new Set<string>();
  if (isolation.mount?.unstable) unstable.add("mount");
  if (isolation.rerender?.stable.unstable) unstable.add("rerender");
  if (isolation.unmount?.unstable) unstable.add("unmount");

  return {
    mount: isolation.mount?.median ?? 0,
    rerender: isolation.rerender?.stable.median ?? 0,
    unmount: isolation.unmount?.median ?? 0,
    domNodeCount,
    interactions: {},
    unstable,
    tier,
  };
}
