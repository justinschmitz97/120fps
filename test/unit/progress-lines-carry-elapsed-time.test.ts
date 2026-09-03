import { describe, it, expect } from "vitest";
import { resolveProgressReporter } from "../../src/analyze.js";
import { createPhaseClock, formatElapsedClock } from "../../src/report.js";

// A clock the test advances by hand: no real time enters an assertion.
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe("elapsed time on progress lines", () => {
  it("ends each line with the run clock in (m:ss)", () => {
    const time = fakeClock();
    const written: string[] = [];
    const clock = createPhaseClock(time.now);
    const report = resolveProgressReporter({}, (s) => written.push(s), clock);

    time.advance(41_000);
    report("explore: 4 combos, budget 15s each");

    expect(written).toEqual(["explore: 4 combos, budget 15s each  (0:41)\n"]);
  });

  it("keeps the label text before the clock unchanged", () => {
    const time = fakeClock();
    const written: string[] = [];
    const clock = createPhaseClock(time.now);
    const report = resolveProgressReporter({}, (s) => written.push(s), clock);

    time.advance(92_400);
    report("mount: 8 combos x 5 samples");

    expect(written[0]).toBe("mount: 8 combos x 5 samples  (1:32)\n");
  });

  it("writes nothing to the sink under --ci", () => {
    const time = fakeClock();
    const seen: string[] = [];
    const written: string[] = [];
    const clock = createPhaseClock(time.now);
    const report = resolveProgressReporter(
      { ci: true, onProgress: (l) => seen.push(l) },
      (s) => written.push(s),
      clock,
    );

    time.advance(5_000);
    report("preflight: walking the import graph");

    expect(seen).toEqual([]);
    expect(written).toEqual([]);
  });

  it("hands onPhase and onProgress the identical string", () => {
    const time = fakeClock();
    const phases: string[] = [];
    const sink: string[] = [];
    const clock = createPhaseClock(time.now);
    const report = resolveProgressReporter(
      { onPhase: (p) => phases.push(p), onProgress: (l) => sink.push(l) },
      () => {},
      clock,
    );

    time.advance(63_000);
    report("rerender: 4 combos");

    expect(phases).toEqual(sink);
    expect(phases).toEqual(["rerender: 4 combos  (1:03)"]);
  });

  it("still reaches onPhase with the clock under --ci", () => {
    const time = fakeClock();
    const phases: string[] = [];
    const clock = createPhaseClock(time.now);
    const report = resolveProgressReporter({ ci: true, onPhase: (p) => phases.push(p) }, () => {}, clock);

    time.advance(3_000);
    report("harness: building");

    expect(phases).toEqual(["harness: building  (0:03)"]);
  });

  it("leaves every line unstamped when no clock is supplied", () => {
    const written: string[] = [];
    const report = resolveProgressReporter({}, (s) => written.push(s));
    report("mount: 8 combos");
    expect(written).toEqual(["mount: 8 combos\n"]);
  });
});

describe("run clock rendering", () => {
  it("pads the seconds to two digits", () => {
    expect(formatElapsedClock(41_000)).toBe("0:41");
    expect(formatElapsedClock(63_000)).toBe("1:03");
    expect(formatElapsedClock(0)).toBe("0:00");
    expect(formatElapsedClock(3_600_000)).toBe("60:00");
  });
});
