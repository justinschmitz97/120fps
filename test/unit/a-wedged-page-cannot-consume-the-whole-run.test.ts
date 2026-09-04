import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  MAX_CONSECUTIVE_DEGRADED_COMBOS,
  createDegradedPassBound,
  measurementAbandonedWarning,
  type MountResult,
  type RerenderResult,
} from "../../src/browser/index.js";
import { buildReport, propDeltasFromMeasured, type BuildReportInput } from "../../src/pipeline/index.js";
import type { DeltaPair } from "../../src/props/index.js";

// midday-F1, end-game fix-up. `withFrameStarvationRetry` bounds one combo;
// nothing bounded a pass. On midday's button the renderer wedged during the
// delta pass, so all ~40 of its combos starved through three bounded retries
// each: 20 minutes with no phase line, then the run watchdog killed the run
// with no report at all. A pass whose combos stop measuring, combo after
// combo, is measuring the page's failure, not the component.

const measureSrc = fs.readFileSync(path.resolve("src", "browser/measure.ts"), "utf-8");
const retrySrc = fs.readFileSync(path.resolve("src", "browser/retry.ts"), "utf-8");
// The delta passes live in the pipeline stage's mode files; the guard below is
// about every one of them, so the whole stage is read as one text.
const pipelineSrc = (dir: string): string =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .map((e) =>
      e.isDirectory()
        ? pipelineSrc(path.join(dir, e.name))
        : fs.readFileSync(path.join(dir, e.name), "utf-8"),
    )
    .join("\n");
const analyzeSrc = pipelineSrc(path.resolve("src", "pipeline"));

describe("a pass stops once the page has stopped measuring anything", () => {
  it("tolerates degraded combos below the bound", () => {
    const bound = createDegradedPassBound("mount", 40, vi.fn());
    for (let i = 0; i < MAX_CONSECUTIVE_DEGRADED_COMBOS - 1; i++) {
      expect(bound.degraded(i)).toBe(false);
    }
  });

  it("abandons the pass on the third consecutive combo that measured nothing", () => {
    const onWarning = vi.fn();
    const bound = createDegradedPassBound("mount", 40, onWarning);
    expect(bound.degraded(20)).toBe(false);
    expect(bound.degraded(21)).toBe(false);
    expect(bound.degraded(22)).toBe(true);
    expect(onWarning).toHaveBeenCalledWith(measurementAbandonedWarning("mount", 3, 17));
  });

  it("counts only consecutive failures: a combo that measured resets the run", () => {
    const onWarning = vi.fn();
    const bound = createDegradedPassBound("rerender", 12, onWarning);
    for (let i = 0; i < 6; i++) {
      expect(bound.degraded(i)).toBe(false);
      expect(bound.degraded(i)).toBe(false);
      bound.measured();
    }
    expect(onWarning).not.toHaveBeenCalled();
  });

  it("names the phase, how many combos failed in a row, and what it skipped", () => {
    const warning = measurementAbandonedWarning("mount", 3, 17);
    expect(warning).toContain("mount:");
    expect(warning).toContain("3 combos in a row");
    expect(warning).toContain("skipped the remaining 17");
    expect(warning).toContain("kept what was measured");
  });

  it("reports the rerender pass under its own name", () => {
    expect(measurementAbandonedWarning("rerender", 3, 0)).toContain("rerender:");
  });
});

describe("both measurement passes are bounded by it", () => {
  it("the mount pass creates the bound and breaks out of its combo loop", () => {
    expect(measureSrc).toContain('createDegradedPassBound("mount", indices.length, options.onWarning)');
    const mountPass = measureSrc.slice(measureSrc.indexOf('createDegradedPassBound("mount"'));
    expect(mountPass).toContain("if (passBound.degraded(position)) break;");
    expect(mountPass).toContain("passBound.measured();");
  });

  it("the rerender pass creates the same bound", () => {
    expect(measureSrc).toContain('createDegradedPassBound("rerender", indices.length, options.onWarning)');
    const rerenderPass = measureSrc.slice(
      measureSrc.indexOf('createDegradedPassBound("rerender"'),
      measureSrc.indexOf('createDegradedPassBound("mount"'),
    );
    expect(rerenderPass).toContain("if (passBound.degraded(position)) break;");
    expect(rerenderPass).toContain("passBound.measured();");
  });

  it("keeps the per-combo retry bound it composes with", () => {
    expect(retrySrc).toContain("export const MAX_FRAME_STARVATION_RETRIES = 2;");
    expect(MAX_CONSECUTIVE_DEGRADED_COMBOS).toBe(3);
  });
});

// The pass loops in measure.ts need a browser to run, so this stands in for
// one: the same bound, the same `new Array(total)` results array written by
// index, the same break. It is here to execute what the bound does to the run
// downstream -- holes in the results array -- which the source greps above
// cannot.
function runBoundedPass(
  phase: "mount" | "rerender",
  total: number,
  measures: (position: number) => boolean,
  onWarning: (warning: string) => void,
): (MountResult | undefined)[] {
  const results: (MountResult | undefined)[] = new Array(total);
  const bound = createDegradedPassBound(phase, total, onWarning);
  for (let position = 0; position < total; position++) {
    if (!measures(position)) {
      if (bound.degraded(position)) break;
      continue;
    }
    bound.measured();
    results[position] = makeMount(position);
  }
  return results;
}

function makeMount(comboIndex: number): MountResult {
  return {
    comboIndex,
    props: { size: comboIndex },
    mount: { samples: [2, 2, 2], median: 2, p95: 2 },
    unmount: { samples: [1, 1, 1], median: 1, p95: 1 },
    domNodeCount: 10,
  };
}

function makeRerender(comboIndex: number, median: number): RerenderResult {
  return {
    comboIndex,
    props: { size: comboIndex },
    stable: { samples: [median, median, median], median, p95: median },
  };
}

function reportInput(
  mounts: (MountResult | undefined)[],
  rerenders?: (RerenderResult | undefined)[],
): BuildReportInput {
  return {
    componentPath: "./Button.tsx",
    componentName: "Button",
    machine: { cpu: "Test", cores: 4, ramMb: 16384, os: "Linux 6.0", nodeVersion: "v22.0.0", chromiumVersion: "120.0.0.0" },
    calibration: { totalDuration: 10, scriptDuration: 5 },
    mounts: mounts as MountResult[],
    rerenders: rerenders as RerenderResult[] | undefined,
    explores: [],
    heapDeltas: [],
    thresholds: { mountMs: 16, interactionMs: 100, relativeMount: 2.0, rerenderMs: 8 },
  };
}

describe("what a pass that stopped early leaves behind", () => {
  it("keeps the combos measured before the bound and none after it", () => {
    const onWarning = vi.fn();
    const wedgesAtFive = (position: number) => position < 5;
    const results = runBoundedPass("mount", 40, wedgesAtFive, onWarning);
    expect(results.filter((r) => r !== undefined).map((r) => r?.comboIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(results.length).toBe(40);
  });

  it("warns the caller, naming the phase and what it skipped", () => {
    const onWarning = vi.fn();
    runBoundedPass("mount", 40, (position) => position < 5, onWarning);
    expect(onWarning).toHaveBeenCalledWith(measurementAbandonedWarning("mount", 3, 32));
  });

  it("says nothing when the pass reached its last combo anyway", () => {
    const onWarning = vi.fn();
    const results = runBoundedPass("rerender", 4, (position) => position < 1, onWarning);
    expect(results.filter((r) => r !== undefined)).toHaveLength(1);
    expect(onWarning).not.toHaveBeenCalled();
  });

  it("builds a report out of what the pass did measure", () => {
    const results = runBoundedPass("mount", 40, (position) => position < 5, vi.fn());
    const report = buildReport(reportInput(results));
    expect(report.combos.map((c) => c.comboIndex)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("the report is built from the measured combos, holes and all", () => {
  it("reports the one combo a wedged pass measured instead of throwing", () => {
    const mounts: (MountResult | undefined)[] = new Array(3);
    mounts[2] = makeMount(2);
    const report = buildReport(reportInput(mounts));
    expect(report.combos).toHaveLength(1);
    expect(report.combos[0].comboIndex).toBe(2);
  });

  it("pairs a measured mount with its rerender across holes in both arrays", () => {
    const mounts: (MountResult | undefined)[] = new Array(3);
    mounts[2] = makeMount(2);
    const rerenders: (RerenderResult | undefined)[] = new Array(3);
    rerenders[2] = makeRerender(2, 4);
    const report = buildReport(reportInput(mounts, rerenders));
    expect(report.combos[0].rerender?.median).toBe(4);
  });
});

const PAIR: DeltaPair = {
  propName: "size",
  baseCombo: { size: 0 },
  flipCombo: { size: 1 },
  baseValue: 0,
  flipValue: 1,
};

describe("a prop delta whose combos were never measured is not reported as zero", () => {
  it("reports the pair when both sides measured both timings", () => {
    const measured = new Map([
      [JSON.stringify(PAIR.baseCombo), { mount: 2, rerender: 1 }],
      [JSON.stringify(PAIR.flipCombo), { mount: 5, rerender: 3 }],
    ]);
    expect(propDeltasFromMeasured([PAIR], measured)).toEqual([
      { propName: "size", baseValue: 0, flipValue: 1, mountDelta: 3, rerenderDelta: 2 },
    ]);
  });

  it("drops a pair whose flip side the mount pass never reached", () => {
    const measured = new Map([[JSON.stringify(PAIR.baseCombo), { mount: 2, rerender: 1 }]]);
    expect(propDeltasFromMeasured([PAIR], measured)).toEqual([]);
  });

  it("drops a pair whose rerender the rerender pass omitted, rather than subtracting a zero", () => {
    const measured = new Map<string, { mount: number; rerender?: number }>([
      [JSON.stringify(PAIR.baseCombo), { mount: 2, rerender: 1 }],
      [JSON.stringify(PAIR.flipCombo), { mount: 5 }],
    ]);
    expect(propDeltasFromMeasured([PAIR], measured)).toEqual([]);
  });

  it("no longer seeds an unmeasured combo with a zero timing", () => {
    expect(analyzeSrc).not.toContain("measured.set(key, { mount: 0, rerender: 0 });");
    expect(analyzeSrc).not.toContain("rerender: 0 });");
  });

  it("both delta paths go through the same guard", () => {
    expect(analyzeSrc).toContain("matrixDeltas = propDeltasFromMeasured(deltaPairs, matrixMedians);");
    expect(analyzeSrc).toContain("const propDeltas = propDeltasFromMeasured(pairs, measured);");
  });
});
