// M115 C1: wall clock around phases, never inside a traced window. The ten
// phase keys are disjoint intervals over one run and sum to `total` exactly,
// so a printed breakdown is checkable against the number beside it.
export interface PhaseTimings {
  preflight: number;
  build: number;
  calibration: number;
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

// The phase a progress label can open. `attribution` is not one of them: no
// progress line names it (M115 C2), and its window is handed to the clock by
// the pass that runs it.
type BoundaryPhase = Exclude<PhaseName, "attribution">;

// Declaration order is print order.
export const PHASE_NAMES: readonly PhaseName[] = [
  "preflight",
  "build",
  "calibration",
  "mount",
  "rerender",
  "explore",
  "scale",
  "deltas",
  "attribution",
  "analysis",
];

// M115 C2: a boundary line is classified by its label alone, so combo, matrix,
// curve and isolation runs are all charged by the same rule. A label matching
// none of them keeps the phase that is already open.
export function classifyPhaseLabel(line: string): BoundaryPhase | "report" | undefined {
  if (line.startsWith("preflight:")) return "preflight";
  if (line.startsWith("harness:")) return "build";
  if (line.startsWith("calibration")) return "calibration";
  if (line.startsWith("mount:")) return "mount";
  if (line.startsWith("rerender:")) return "rerender";
  if (line.startsWith("explore:")) return "explore";
  if (line.startsWith("scaling curves")) return "scale";
  if (line.startsWith("prop deltas")) return "deltas";
  if (line.startsWith("react analysis")) return "analysis";
  if (line === "report") return "report";
  return undefined;
}

export interface PhaseClock {
  // Charges the interval since the previous boundary and opens the phase this
  // label names. Returns the elapsed run clock at that boundary, which is what
  // the progress line prints.
  boundary(line: string): number;
  // The window a cost-attribution pass ran in, carved out of whichever phase
  // was open so no millisecond is counted twice.
  addAttribution(ms: number): void;
  elapsedMs(): number;
  // Reads the timings without closing the clock: for a caller that runs before
  // the `report` boundary and must not decide where the total ends.
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
    mount: 0,
    rerender: 0,
    explore: 0,
    scale: 0,
    deltas: 0,
    attribution: 0,
    analysis: 0,
  };
  // The interval before the first `preflight:` boundary is charged to
  // preflight: it is the run's own start-up, and preflight is what follows it.
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

// Whole seconds up to a minute, then minutes and seconds: the units the
// terminal's own `Total:` line prints.
export function formatPhaseDuration(ms: number): string {
  const wholeSeconds = Math.round(ms / 1000);
  if (wholeSeconds < 60) return `${wholeSeconds}s`;
  const minutes = Math.floor(wholeSeconds / 60);
  return `${minutes}m ${wholeSeconds - minutes * 60}s`;
}

// M115 C4: the run clock beside every progress line.
export function formatElapsedClock(ms: number): string {
  const wholeSeconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(wholeSeconds / 60);
  return `${minutes}:${String(wholeSeconds - minutes * 60).padStart(2, "0")}`;
}

// A phase at zero is omitted: a run that never explored says nothing about
// exploring rather than claiming it took no time.
export function describePhaseBreakdown(timings: PhaseTimings | undefined): string {
  if (!timings) return "";
  return PHASE_NAMES
    .filter((name) => timings[name] > 0)
    .map((name) => `${name} ${formatPhaseDuration(timings[name])}`)
    .join(", ");
}

// I11: appended to the terminal's `Total:` line by the CLI.
export function formatPhaseBreakdown(timings: PhaseTimings | undefined): string {
  const described = describePhaseBreakdown(timings);
  return described === "" ? "" : `  (${described})`;
}
