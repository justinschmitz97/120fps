// Disjoint intervals summing to `total` exactly, measured outside every traced window.
export interface PhaseTimings {
  preflight: number;
  build: number;
  calibration: number;
  setup: number;
  mount: number;
  rerender: number;
  explore: number;
  scale: number;
  deltas: number;
  attribution: number;
  analysis: number;
  total: number;
}

export type PhaseName = Exclude<keyof PhaseTimings, "total">;

// `attribution` is excluded: no progress line names it; addAttribution supplies its window.
type BoundaryPhase = Exclude<PhaseName, "attribution">;

// Declaration order is print order.
export const PHASE_NAMES: readonly PhaseName[] = [
  "preflight",
  "build",
  "calibration",
  "setup",
  "mount",
  "rerender",
  "explore",
  "scale",
  "deltas",
  "attribution",
  "analysis",
];

// A label matching none of these keeps the phase that is already open.
export function classifyPhaseLabel(line: string): BoundaryPhase | "report" | undefined {
  if (line.startsWith("preflight:")) return "preflight";
  if (line.startsWith("harness:")) return "build";
  if (line.startsWith("calibration")) return "calibration";
  if (line.startsWith("setup")) return "setup";
  // The mode line is the last boundary before the first measurement, so calibration ends by here.
  if (line.startsWith("mode:")) return "setup";
  if (line.startsWith("mount:")) return "mount";
  // An isolation run measures mount, rerender, unmount and memory under one label.
  if (line.startsWith("isolation:")) return "mount";
  if (line.startsWith("rerender:")) return "rerender";
  if (line.startsWith("explore:")) return "explore";
  if (line.startsWith("scaling curves")) return "scale";
  if (line.startsWith("prop deltas")) return "deltas";
  if (line.startsWith("react analysis")) return "analysis";
  if (line === "report") return "report";
  return undefined;
}

export interface PhaseClock {
  // Returns the elapsed run clock at the boundary, which is what the progress line prints.
  boundary(line: string): number;
  // Carved out of whichever phase is open, so no millisecond is counted twice.
  addAttribution(ms: number): void;
  elapsedMs(): number;
  // Does not close the clock: for a caller that must not decide where the total ends.
  snapshot(): PhaseTimings;
  // Closes the total at the `report` boundary if one arrived, otherwise now.
  timings(): PhaseTimings;
}

export function createPhaseClock(now: () => number = Date.now): PhaseClock {
  const start = now();
  const spent: Record<PhaseName, number> = {
    preflight: 0,
    build: 0,
    calibration: 0,
    setup: 0,
    mount: 0,
    rerender: 0,
    explore: 0,
    scale: 0,
    deltas: 0,
    attribution: 0,
    analysis: 0,
  };
  // Start-up before the first `preflight:` boundary is charged to preflight.
  let open: BoundaryPhase = "preflight";
  let mark = start;
  let pendingAttribution = 0;
  let total: number | undefined;

  const attributedShare = (at: number): number => Math.min(pendingAttribution, at - mark);

  return {
    boundary(line) {
      const at = now();
      if (total !== undefined) return at - start;
      const phase = classifyPhaseLabel(line);
      const attributed = attributedShare(at);
      spent[open] += at - mark - attributed;
      spent.attribution += attributed;
      pendingAttribution = 0;
      mark = at;
      if (phase === "report") total = at - start;
      else if (phase) open = phase;
      return at - start;
    },
    addAttribution(ms) {
      if (ms > 0) pendingAttribution += ms;
    },
    elapsedMs() {
      return now() - start;
    },
    snapshot() {
      if (total !== undefined) return { ...spent, total };
      const at = now();
      const attributed = attributedShare(at);
      const live = { ...spent };
      live[open] += at - mark - attributed;
      live.attribution += attributed;
      return { ...live, total: at - start };
    },
    timings() {
      if (total === undefined) {
        const at = now();
        const attributed = attributedShare(at);
        spent[open] += at - mark - attributed;
        spent.attribution += attributed;
        pendingAttribution = 0;
        mark = at;
        total = at - start;
      }
      return { ...spent, total };
    },
  };
}

// The units the terminal's own `Total:` line prints.
export function formatPhaseDuration(ms: number): string {
  const wholeSeconds = Math.round(ms / 1000);
  if (wholeSeconds < 60) return `${wholeSeconds}s`;
  const minutes = Math.floor(wholeSeconds / 60);
  return `${minutes}m ${wholeSeconds - minutes * 60}s`;
}

// The run clock beside every progress line.
export function formatElapsedClock(ms: number): string {
  const wholeSeconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(wholeSeconds / 60);
  return `${minutes}:${String(wholeSeconds - minutes * 60).padStart(2, "0")}`;
}

// A phase at zero is omitted; printing it would claim the phase took no time.
export function describePhaseBreakdown(timings: PhaseTimings | undefined): string {
  if (!timings) return "";
  return PHASE_NAMES
    .filter((name) => timings[name] > 0)
    .map((name) => `${name} ${formatPhaseDuration(timings[name])}`)
    .join(", ");
}

// Appended to the terminal's `Total:` line by the CLI.
export function formatPhaseBreakdown(timings: PhaseTimings | undefined): string {
  const described = describePhaseBreakdown(timings);
  return described === "" ? "" : `  (${described})`;
}
