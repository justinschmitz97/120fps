import { describe, it, expect } from "vitest";
import {
  selectExploreCombos,
  EXPLORE_BUDGET_WARNING,
  DEFAULT_MAX_COMBOS,
  DEFAULT_TOTAL_WALL_CLOCK_MS,
} from "../../src/explorer.js";

describe("m30 F4 — exploration has a run-level budget", () => {
  it("explores every combo when the count is within the cap", () => {
    expect(selectExploreCombos(5, 8)).toEqual([0, 1, 2, 3, 4]);
  });

  it("keeps first and last when it has to choose", () => {
    const picked = selectExploreCombos(27, 8);
    expect(picked.length).toBe(8);
    expect(picked[0]).toBe(0);
    expect(picked[picked.length - 1]).toBe(26);
  });

  it("returns strictly ascending unique indices", () => {
    const picked = selectExploreCombos(64, 8);
    expect(new Set(picked).size).toBe(picked.length);
    for (let i = 1; i < picked.length; i++) {
      expect(picked[i]).toBeGreaterThan(picked[i - 1]);
    }
  });

  it("spreads interior picks rather than clustering at the ends", () => {
    const picked = selectExploreCombos(64, 4);
    expect(picked).toEqual([0, 21, 42, 63]);
  });

  it("is deterministic", () => {
    expect(selectExploreCombos(27, 8)).toEqual(selectExploreCombos(27, 8));
  });

  it("handles a single combo", () => {
    expect(selectExploreCombos(1, 8)).toEqual([0]);
  });

  it("handles zero combos", () => {
    expect(selectExploreCombos(0, 8)).toEqual([]);
  });

  it("never returns more than the cap", () => {
    expect(selectExploreCombos(1000, 3).length).toBe(3);
  });

  it("treats a cap of zero as no exploration", () => {
    expect(selectExploreCombos(10, 0)).toEqual([]);
  });

  it("discloses how many combos were skipped", () => {
    const warning = EXPLORE_BUDGET_WARNING(8, 27);
    expect(warning).toContain("8");
    expect(warning).toContain("19");
  });

  it("ships defaults that bound a worst-case run", () => {
    expect(DEFAULT_MAX_COMBOS).toBe(8);
    expect(DEFAULT_TOTAL_WALL_CLOCK_MS).toBe(300000);
  });
});
