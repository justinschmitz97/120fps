import { buildTimingWithCV, type TimingWithCV } from "./report.js";

export type IsolationPhase = "mount" | "rerender" | "unmount" | "memory" | "strictmode";

const ALL_PHASES: IsolationPhase[] = ["mount", "rerender", "unmount", "memory", "strictmode"];

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

  if (parts.length === 1 && parts[0] === "all") {
    return [...ALL_PHASES];
  }

  const seen = new Set<IsolationPhase>();
  for (const p of parts) {
    if (!ALL_PHASES.includes(p as IsolationPhase)) {
      throw new Error(`Invalid isolation phase: "${p}". Valid phases: ${ALL_PHASES.join(", ")}, all`);
    }
    seen.add(p as IsolationPhase);
  }

  return [...seen];
}

export function computeChurnDegradation(samples: number[]): number {
  if (samples.length < 6) return samples.length === 0 ? 1.0 : samples[samples.length - 1] / (samples[0] || 1);
  const first3 = (samples[0] + samples[1] + samples[2]) / 3;
  const last3 = (samples[samples.length - 3] + samples[samples.length - 2] + samples[samples.length - 1]) / 3;
  if (first3 === 0) return 1.0;
  return last3 / first3;
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
    leakSuspected: heapGrowthPerCycle > 1024,
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
    churn: buildTimingWithCV(churnSamples),
    churnDegradation: computeChurnDegradation(churnSamples),
  };
}
