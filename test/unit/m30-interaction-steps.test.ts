import { describe, it, expect } from "vitest";
import {
  computeVerdict,
  DEFAULT_THRESHOLDS,
  REFERENCE_EVENTS,
  TIER_BUDGETS,
  type ComboReport,
  type InteractionReport,
} from "../../src/report.js";

function timing(median: number) {
  return { samples: [median], median, p95: median, cv: 0, unstable: false };
}

function interaction(median: number, steps?: number): InteractionReport {
  return {
    label: "x",
    type: "click",
    selector: "button",
    timing: timing(median),
    relativeTiming: 0.1,
    ...(steps === undefined ? {} : { steps }),
  } as InteractionReport;
}

function combo(interactions: InteractionReport[]): ComboReport {
  return {
    comboIndex: 0,
    props: {},
    mount: timing(1),
    unmount: timing(1),
    rerender: timing(1),
    relativeMount: 0.01,
    domNodeCount: 10,
    interactions,
    verdict: "pass",
  } as ComboReport;
}

const T3 = TIER_BUDGETS.T3;

describe("m30 F5 — interaction budgets are per step", () => {
  // M33 E2 replaced the divide-by-11 rule with a frame-derived per-event
  // budget; REFERENCE_EVENTS survives only to translate an explicitly supplied
  // aggregate --threshold-interaction. See test/unit/m33-frame-budgets.test.ts.
  it("keeps the reference count for explicit aggregate thresholds", () => {
    expect(REFERENCE_EVENTS).toBe(11);
  });

  it("compares against the tier per-event budget", () => {
    // T3 allows 67ms per event: 11 events at 6ms pass, at 7ms fail.
    expect(computeVerdict(combo([interaction(66 * 11, 11)]), DEFAULT_THRESHOLDS, { tierBudget: T3 })).toBe("pass");
    expect(computeVerdict(combo([interaction(68 * 11, 11)]), DEFAULT_THRESHOLDS, { tierBudget: T3 })).toBe("fail");
  });

  it("stops leaving a single-shot interaction effectively unbudgeted", () => {
    // One click costing 200ms passed under the old aggregate comparison.
    expect(computeVerdict(combo([interaction(200, 1)]), DEFAULT_THRESHOLDS, { tierBudget: T3 })).toBe("fail");
  });

  it("passes a single click inside one 60fps frame", () => {
    expect(computeVerdict(combo([interaction(60, 1)]), DEFAULT_THRESHOLDS, { tierBudget: T3 })).toBe("pass");
  });

  it("passes a cheap single-shot interaction", () => {
    expect(computeVerdict(combo([interaction(20, 1)]), DEFAULT_THRESHOLDS, { tierBudget: T3 })).toBe("pass");
  });

  it("stops failing a 60-event drag for having many events", () => {
    // 60 moves at 20ms each: far over the aggregate budget, fine per event.
    expect(computeVerdict(combo([interaction(1200, 60)]), DEFAULT_THRESHOLDS, { tierBudget: T3 })).toBe("pass");
  });

  it("still fails a genuinely expensive drag", () => {
    expect(computeVerdict(combo([interaction(6000, 60)]), DEFAULT_THRESHOLDS, { tierBudget: T3 })).toBe("fail");
  });

  it("treats a missing event count as a single event", () => {
    expect(computeVerdict(combo([interaction(68)]), DEFAULT_THRESHOLDS, { tierBudget: T3 })).toBe("fail");
    expect(computeVerdict(combo([interaction(66)]), DEFAULT_THRESHOLDS, { tierBudget: T3 })).toBe("pass");
  });

  it("treats a zero event count as one rather than dividing by zero", () => {
    expect(computeVerdict(combo([interaction(351, 0)]), DEFAULT_THRESHOLDS, { tierBudget: T3 })).toBe("fail");
  });

  it("uses the flat per-event threshold when no tier applies", () => {
    expect(computeVerdict(combo([interaction(100, 1)]), DEFAULT_THRESHOLDS)).toBe("fail");
    expect(computeVerdict(combo([interaction(30, 1)]), DEFAULT_THRESHOLDS)).toBe("pass");
  });
});
