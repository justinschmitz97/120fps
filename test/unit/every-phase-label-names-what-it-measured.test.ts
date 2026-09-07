import { describe, it, expect } from "vitest";
import {
  classifyPhaseLabel,
  createPhaseClock,
  PHASE_NAMES,
  type PhaseTimings,
} from "../../src/report/index.js";

function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 100_000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function sumOfPhases(timings: PhaseTimings): number {
  return PHASE_NAMES.reduce((sum, name) => sum + timings[name], 0);
}

describe("the label that closes the calibration phase", () => {
  it("classifies the boundary the run prints when calibration ends", () => {
    expect(classifyPhaseLabel("setup")).toBe("setup");
  });

  it("classifies the mode line, so calibration cannot run into the first measurement", () => {
    expect(classifyPhaseLabel("mode: prop combos")).toBe("setup");
    expect(classifyPhaseLabel("mode: curve on items")).toBe("setup");
    expect(classifyPhaseLabel("mode: prop matrix")).toBe("setup");
  });

  it("charges an isolation run's measurement to mount, never to setup", () => {
    expect(classifyPhaseLabel("isolation: mount,unmount")).toBe("mount");
    expect(classifyPhaseLabel("isolation: memory")).toBe("mount");
  });
});

describe("an isolation run's phase table", () => {
  it("names the phase its measurement went to", () => {
    const time = fakeClock();
    const clock = createPhaseClock(time.now);

    clock.boundary("harness: building");
    time.advance(4_000);
    clock.boundary("calibration");
    time.advance(100);
    clock.boundary("setup");
    time.advance(900);
    clock.boundary("isolation: mount,unmount");
    time.advance(30_000);
    clock.boundary("report");

    const timings = clock.timings();
    expect(timings.build).toBe(4_000);
    expect(timings.calibration).toBe(100);
    expect(timings.setup).toBe(900);
    expect(timings.mount).toBe(30_000);
    expect(sumOfPhases(timings)).toBe(timings.total);
  });
});

describe("a run's phase table", () => {
  it("holds only the calibration interval in the calibration bucket", () => {
    const time = fakeClock();
    const clock = createPhaseClock(time.now);

    clock.boundary("harness: building");
    time.advance(4_000);
    clock.boundary("calibration");
    time.advance(93);
    clock.boundary("setup");
    time.advance(3_134);
    clock.boundary("mode: prop combos");
    time.advance(500);
    clock.boundary("mount: 6 combos x 3 samples");
    time.advance(4_349);
    clock.boundary("report");

    const timings = clock.timings();
    expect(timings.calibration).toBe(93);
    expect(timings.setup).toBe(3_634);
    expect(timings.mount).toBe(4_349);
  });

  it("carries every phase key, disjoint, summing to the total", () => {
    const time = fakeClock();
    const clock = createPhaseClock(time.now);

    time.advance(120);
    clock.boundary("preflight: walking the import graph");
    time.advance(3_942);
    clock.boundary("harness: building");
    time.advance(2_530);
    clock.boundary("calibration");
    time.advance(90);
    clock.boundary("setup");
    time.advance(2_440);
    clock.boundary("mount: 6 combos x 3 samples");
    time.advance(4_349);
    clock.boundary("rerender: 6 combos");
    time.advance(1_509);
    clock.boundary("explore: 2 combos, budget 15s each");
    time.advance(2_775);
    clock.boundary("react analysis");
    time.advance(27_798);
    clock.boundary("report");

    const timings = clock.timings();
    expect(Object.keys(timings).sort()).toEqual(
      ["analysis", "attribution", "build", "calibration", "deltas", "explore",
       "mount", "preflight", "rerender", "scale", "setup", "total"],
    );
    expect(sumOfPhases(timings)).toBe(timings.total);
  });

  it("reports zero setup for a run that never reached calibration", () => {
    const time = fakeClock();
    const clock = createPhaseClock(time.now);

    time.advance(1_000);
    clock.boundary("preflight: walking the import graph");
    time.advance(1_000);
    clock.boundary("report");

    const timings = clock.timings();
    expect(timings.calibration).toBe(0);
    expect(timings.setup).toBe(0);
  });

  it("closes calibration at the mode line when no setup boundary arrived", () => {
    const time = fakeClock();
    const clock = createPhaseClock(time.now);

    clock.boundary("calibration");
    time.advance(2_000);
    clock.boundary("mode: curve on items");
    time.advance(6_000);
    clock.boundary("mount: 6 scale points");
    time.advance(1_000);
    clock.boundary("report");

    const timings = clock.timings();
    expect(timings.calibration).toBe(2_000);
    expect(timings.setup).toBe(6_000);
    expect(sumOfPhases(timings)).toBe(timings.total);
  });
});
