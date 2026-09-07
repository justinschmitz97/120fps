import { describe, it, expect } from "vitest";
import {
  DEFAULT_EXPLORE_PHASE_WALL_CLOCK_MS,
  explorePhaseBudgetSpent,
  exploreRunOptions,
} from "../../src/analysis/index.js";

const oneCombo = (exploreBudgetMs?: number) =>
  exploreRunOptions(
    exploreBudgetMs === undefined ? {} : { exploreBudgetMs },
    1,
    DEFAULT_EXPLORE_PHASE_WALL_CLOCK_MS,
  );

describe("a run with a single prop combo", () => {
  it("reports the budget the user asked for, not the run-level default", () => {
    expect(oneCombo(30_000).maxWallClockMs).toBe(30_000);
    expect(Math.round(oneCombo(30_000).maxWallClockMs / 1000)).toBe(30);
  });

  it("keeps the sixty-second bound when the user asked for nothing", () => {
    expect(oneCombo().maxWallClockMs).toBe(60_000);
  });

  it("cannot outlive the phase budget", () => {
    for (const budget of [1_000, 5_000, 12_500, 30_000, 45_000]) {
      expect(oneCombo(budget).maxWallClockMs).toBeLessThanOrEqual(budget);
    }
  });

  it("is stopped before it starts when the phase budget is already spent", () => {
    expect(explorePhaseBudgetSpent(30_100, 30_000)).toBe(true);
  });
});
