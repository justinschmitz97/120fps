import { describe, it, expect } from "vitest";
import {
  DEFAULT_EXPLORE_PHASE_WALL_CLOCK_MS,
  EXPLORE_BUDGET_WARNING,
  EXPLORE_COMBO_TRUNCATED_WARNING,
  MIN_EXPLORE_UNIT_WALL_CLOCK_MS,
  exploreComboWallClockMs,
  explorePhaseBudgetSpent,
  exploreRunOptions,
} from "../../src/analysis/index.js";
import { CURVE_POINT_WALL_CLOCK_MS } from "../../src/pipeline/index.js";

const comboPhase = (options: { exploreBudgetMs?: number; observerTiming?: boolean }, combos: number) =>
  exploreRunOptions(options, combos, DEFAULT_EXPLORE_PHASE_WALL_CLOCK_MS);

const curvePhase = (options: { exploreBudgetMs?: number }, points: number) =>
  exploreRunOptions(options, points, points * CURVE_POINT_WALL_CLOCK_MS);

describe("the per-combo bound the explore phase hands out", () => {
  it("derives it from the flag the user passed", () => {
    expect(comboPhase({ exploreBudgetMs: 30_000 }, 2).maxWallClockMs).toBe(15_000);
    expect(comboPhase({ exploreBudgetMs: 60_000 }, 2).maxWallClockMs).toBe(30_000);
    expect(comboPhase({ exploreBudgetMs: 120_000 }, 4).maxWallClockMs).toBe(15_000);
  });

  it("keeps the bound the run used before the flag reached it when no flag was passed", () => {
    expect(comboPhase({}, 1).maxWallClockMs).toBe(60_000);
    expect(comboPhase({}, 2).maxWallClockMs).toBe(30_000);
    expect(comboPhase({}, 6).maxWallClockMs).toBe(10_000);
    expect(comboPhase({}, 8).maxWallClockMs).toBe(10_000);
  });

  it("never hands a combo more time than the whole phase has", () => {
    expect(comboPhase({ exploreBudgetMs: 5_000 }, 1).maxWallClockMs).toBe(5_000);
    expect(comboPhase({ exploreBudgetMs: 8_000 }, 4).maxWallClockMs).toBe(8_000);
    expect(comboPhase({ exploreBudgetMs: 0 }, 3).maxWallClockMs).toBe(0);
  });

  it("never divides a combo's bound below the floor a useful walk needs", () => {
    expect(comboPhase({ exploreBudgetMs: 300_000 }, 60).maxWallClockMs).toBe(
      MIN_EXPLORE_UNIT_WALL_CLOCK_MS,
    );
  });

  it("raises the flag but never extends a combo past the phase's own default", () => {
    expect(comboPhase({ exploreBudgetMs: 600_000 }, 1).maxWallClockMs).toBe(60_000);
  });

  it("hands the phase budget to the run-level check", () => {
    expect(comboPhase({ exploreBudgetMs: 30_000 }, 2).totalWallClockMs).toBe(30_000);
    expect(comboPhase({}, 2).totalWallClockMs).toBeUndefined();
  });
});

describe("the bound curve mode hands each scale point", () => {
  it("divides the phase budget across the points instead of giving each the whole of it", () => {
    expect(curvePhase({ exploreBudgetMs: 30_000 }, 6).maxWallClockMs).toBe(10_000);
    expect(curvePhase({ exploreBudgetMs: 30_000 }, 6).totalWallClockMs).toBe(30_000);
    expect(curvePhase({ exploreBudgetMs: 120_000 }, 6).maxWallClockMs).toBe(20_000);
  });

  it("keeps the per-point bound the sweep used before the flag reached it", () => {
    expect(curvePhase({}, 6).maxWallClockMs).toBe(CURVE_POINT_WALL_CLOCK_MS);
    expect(curvePhase({}, 1).maxWallClockMs).toBe(CURVE_POINT_WALL_CLOCK_MS);
    expect(curvePhase({}, 6).totalWallClockMs).toBeUndefined();
  });
});

describe("what the run says when the budget stopped the phase", () => {
  it("names the flag that stopped it and the unit it stopped counting", () => {
    expect(EXPLORE_BUDGET_WARNING(1, 2)).toContain("--explore-budget");
    expect(EXPLORE_BUDGET_WARNING(1, 2)).toContain("1 of 2 prop combos");
    expect(EXPLORE_BUDGET_WARNING(3, 6, "scale points")).toContain("3 of 6 scale points");
    expect(EXPLORE_BUDGET_WARNING(3, 6, "scale points")).toContain("Skipped scale points");
  });

  it("names the flag when a combo's own share was cut short", () => {
    const warning = EXPLORE_COMBO_TRUNCATED_WARNING(1, 12_800, 15_000);
    expect(warning).toContain("combo 1");
    expect(warning).toContain("12.8s");
    expect(warning).toContain("15.0s");
    expect(warning).toContain("--explore-budget");
  });
});

describe("what one combo may spend once the phase has been running", () => {
  it("hands over its whole share while the phase has room for it", () => {
    expect(exploreComboWallClockMs(15_000, 3_000, 30_000)).toBe(15_000);
    expect(exploreComboWallClockMs(15_000, 0, 30_000)).toBe(15_000);
  });

  it("cuts the share to what the phase has left", () => {
    expect(exploreComboWallClockMs(15_000, 18_000, 30_000)).toBe(12_000);
  });

  it("never cuts a walk below the floor, so a cut combo still reaches a second state", () => {
    expect(exploreComboWallClockMs(15_000, 28_000, 30_000)).toBe(MIN_EXPLORE_UNIT_WALL_CLOCK_MS);
    expect(exploreComboWallClockMs(15_000, 40_000, 30_000)).toBe(MIN_EXPLORE_UNIT_WALL_CLOCK_MS);
  });

  it("never raises a share that was already below the floor", () => {
    expect(exploreComboWallClockMs(5_000, 4_000, 5_000)).toBe(5_000);
    expect(exploreComboWallClockMs(5_000, 5_000, 5_000)).toBe(5_000);
  });
});

describe("the run-level check that stops the phase", () => {
  it("stops before a combo starts once the phase budget is spent", () => {
    expect(explorePhaseBudgetSpent(30_000, 30_000)).toBe(true);
    expect(explorePhaseBudgetSpent(31_600, 30_000)).toBe(true);
  });

  it("lets a combo start while the phase budget is unspent", () => {
    expect(explorePhaseBudgetSpent(0, 30_000)).toBe(false);
    expect(explorePhaseBudgetSpent(29_999, 30_000)).toBe(false);
  });
});

describe("the cheap sampling path", () => {
  it("reaches the exploration loop when the caller selects it", () => {
    expect(comboPhase({ observerTiming: true }, 2).observerTiming).toBe(true);
    expect(curvePhase({ exploreBudgetMs: 30_000 }, 6)).not.toHaveProperty("observerTiming");
  });

  it("stays off unless the caller asks for it", () => {
    expect(comboPhase({}, 2)).not.toHaveProperty("observerTiming");
    expect(comboPhase({ observerTiming: false }, 2)).not.toHaveProperty("observerTiming");
  });
});
