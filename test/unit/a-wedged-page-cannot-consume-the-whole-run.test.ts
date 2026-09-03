import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  MAX_CONSECUTIVE_DEGRADED_COMBOS,
  createDegradedPassBound,
  measurementAbandonedWarning,
} from "../../src/measure.js";

// midday-F1, end-game fix-up. `withFrameStarvationRetry` bounds one combo;
// nothing bounded a pass. On midday's button the renderer wedged during the
// delta pass, so all ~40 of its combos starved through three bounded retries
// each: 20 minutes with no phase line, then the run watchdog killed the run
// with no report at all. A pass whose combos stop measuring, combo after
// combo, is measuring the page's failure, not the component.

const measureSrc = fs.readFileSync(path.resolve("src", "measure.ts"), "utf-8");
const analyzeSrc = fs.readFileSync(path.resolve("src", "analyze.ts"), "utf-8");

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
    expect(measureSrc).toContain("export const MAX_FRAME_STARVATION_RETRIES = 2;");
    expect(MAX_CONSECUTIVE_DEGRADED_COMBOS).toBe(3);
  });
});

describe("a prop delta whose combos were never measured is not reported as zero", () => {
  it("no longer seeds an unmeasured combo with a zero timing", () => {
    expect(analyzeSrc).not.toContain("measured.set(key, { mount: 0, rerender: 0 });");
    expect(analyzeSrc).toContain("const requested = new Set<string>();");
  });

  it("drops the pair instead of subtracting two zeros", () => {
    const deltas = analyzeSrc.slice(analyzeSrc.indexOf("const propDeltas = pairs.flatMap"));
    expect(deltas).toContain("if (!base || !flip) return [];");
    expect(deltas.slice(0, 800)).toContain("if (propDeltas.length === 0) return undefined;");
  });
});
