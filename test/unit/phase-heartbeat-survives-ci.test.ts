import { describe, it, expect } from "vitest";
import { resolveProgressReporter } from "../../src/analyze.js";

// Review A2: `--ci` owns stdout for JSON, so progress reporting is silenced
// there. Lane A's run watchdog re-arms on each phase boundary; silenced with
// the console output, a CI run degrades to one total-budget abort that cannot
// say which phase hung.

describe("phase boundaries reach the watchdog on every path", () => {
  it("still fires under --ci, where console progress is silenced", () => {
    const phases: string[] = [];
    const written: string[] = [];
    const report = resolveProgressReporter(
      { ci: true, onPhase: (p) => phases.push(p) },
      (chunk) => written.push(chunk),
    );
    for (const phase of ["preflight", "harness: building", "calibration", "mount: 8 combos"]) {
      report(phase);
    }
    expect(phases).toEqual(["preflight", "harness: building", "calibration", "mount: 8 combos"]);
    expect(written).toEqual([]);
  });

  it("fires alongside a caller-supplied progress sink", () => {
    const phases: string[] = [];
    const progress: string[] = [];
    const report = resolveProgressReporter({
      onPhase: (p) => phases.push(p),
      onProgress: (line) => progress.push(line),
    });
    report("explore: 2 combos");
    expect(phases).toEqual(["explore: 2 combos"]);
    expect(progress).toEqual(["explore: 2 combos"]);
  });

  it("fires alongside the default stdout writer", () => {
    const phases: string[] = [];
    const written: string[] = [];
    const report = resolveProgressReporter(
      { onPhase: (p) => phases.push(p) },
      (chunk) => written.push(chunk),
    );
    report("rerender: 8 combos");
    expect(phases).toEqual(["rerender: 8 combos"]);
    expect(written).toEqual(["rerender: 8 combos\n"]);
  });

  it("changes nothing for a caller that supplies no sink", () => {
    const written: string[] = [];
    resolveProgressReporter({ ci: true }, (chunk) => written.push(chunk))("mount");
    expect(written).toEqual([]);
    const shown: string[] = [];
    resolveProgressReporter({}, (chunk) => shown.push(chunk))("mount");
    expect(shown).toEqual(["mount\n"]);
  });
});
