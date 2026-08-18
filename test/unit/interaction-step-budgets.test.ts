import { describe, it, expect } from "vitest";
import {
  computeVerdict,
  DEFAULT_THRESHOLDS,
  perStepCost,
  REFERENCE_EVENTS,
  TIER_BUDGETS,
  type ComboReport,
  type InteractionReport,
} from "../../src/report.js";
import { countPatternEvents, resolveStressPattern } from "../../src/stress-patterns.js";
import type { InteractionDescriptor } from "../../src/discovery.js";

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

describe("interaction budgets are per step", () => {
  // The "interaction-step budgets: the budget is one frame" tests below
  // replaced the divide-by-11 rule with a frame-derived per-event budget;
  // REFERENCE_EVENTS survives only to translate an explicitly supplied
  // aggregate --threshold-interaction.
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

function descriptor(over: Partial<InteractionDescriptor> = {}): InteractionDescriptor {
  return { selector: "button", type: "click", label: "x", tagName: "BUTTON", ...over } as InteractionDescriptor;
}

describe("counting pattern events: the unit is one event", () => {
  it("counts a click pattern as its click count", () => {
    expect(countPatternEvents(resolveStressPattern(descriptor()))).toBe(11);
  });

  it("counts a drag as its move count, not its step count", () => {
    const pattern = resolveStressPattern(descriptor({ type: "click", role: "slider" }));
    expect(pattern.name).toBe("pointer-drag");
    expect(pattern.steps.length).toBe(1);
    expect(countPatternEvents(pattern)).toBe(60);
  });

  it("counts a single-shot as one", () => {
    expect(countPatternEvents({ name: "single-shot", steps: [{ action: "focus", selector: "a" }] })).toBe(1);
  });

  it("counts an empty pattern as one, never zero", () => {
    expect(countPatternEvents({ name: "x", steps: [] })).toBe(1);
  });

  it("sums mixed steps", () => {
    expect(
      countPatternEvents({
        name: "mixed",
        steps: [
          { action: "click", selector: "a" },
          { action: "pointer-drag", selector: "b", moveCount: 10 },
        ],
      }),
    ).toBe(11);
  });
});

function frameCombo(median: number, steps: number): ComboReport {
  return {
    comboIndex: 0,
    props: {},
    mount: timing(1),
    unmount: timing(1),
    rerender: timing(1),
    relativeMount: 0.01,
    domNodeCount: 5,
    interactions: [
      { label: "x", type: "click", selector: "b", timing: timing(median), relativeTiming: 0.1, steps } as InteractionReport,
    ],
    verdict: "pass",
  } as ComboReport;
}

describe("interaction-step budgets: the budget is one frame", () => {
  it("derives tier budgets from frame times under 4x throttle", () => {
    expect(TIER_BUDGETS.T1.interactionStepMs).toBe(33);
    expect(TIER_BUDGETS.T2.interactionStepMs).toBe(50);
    expect(TIER_BUDGETS.T3.interactionStepMs).toBe(67);
    expect(TIER_BUDGETS.T4.interactionStepMs).toBe(100);
    expect(DEFAULT_THRESHOLDS.interactionStepMs).toBe(67);
  });

  // Values below are measured per-event costs from the dogfooding repos.
  it("passes a Button with loading and spotlight at T3 (39.2ms/event)", () => {
    expect(computeVerdict(frameCombo(431, 11), DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T3 })).toBe("pass");
  });

  it("fails the same interaction at T1, where a 120fps frame is the budget", () => {
    expect(computeVerdict(frameCombo(431, 11), DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T1 })).toBe("fail");
  });

  it("passes a 60-move comparison drag (20.8ms/event)", () => {
    expect(computeVerdict(frameCombo(1249, 60), DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T3 })).toBe("pass");
  });

  it("fails a whole-application interaction (205.9ms/event)", () => {
    expect(computeVerdict(frameCombo(2265, 11), DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T3 })).toBe("fail");
  });

  it("passes a cheap component interaction (8.6ms/event)", () => {
    expect(computeVerdict(frameCombo(95, 11), DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T1 })).toBe("pass");
  });

  it("treats a missing event count as one event", () => {
    const c = frameCombo(100, 1);
    delete (c.interactions[0] as { steps?: number }).steps;
    expect(computeVerdict(c, DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T3 })).toBe("fail");
  });

  it("keeps an explicit --threshold-interaction on its aggregate meaning", () => {
    expect(REFERENCE_EVENTS).toBe(11);
    const flat = { ...DEFAULT_THRESHOLDS, interactionMs: 110 };
    // 110ms over 11 reference events is a 10ms per-event budget.
    expect(computeVerdict(frameCombo(99, 11), flat, { explicitInteraction: true })).toBe("pass");
    expect(computeVerdict(frameCombo(121, 11), flat, { explicitInteraction: true })).toBe("fail");
  });
});

function stepCombo(median: number, steps?: number) {
  const t = { samples: [median], median, p95: median, cv: 0, unstable: false };
  return {
    comboIndex: 0,
    props: {},
    mount: { samples: [1], median: 1, p95: 1, cv: 0, unstable: false },
    unmount: { samples: [1], median: 1, p95: 1, cv: 0, unstable: false },
    rerender: { samples: [1], median: 1, p95: 1, cv: 0, unstable: false },
    relativeMount: 0.01,
    domNodeCount: 10,
    interactions: [
      {
        label: "x",
        type: "click" as const,
        selector: "button",
        timing: t,
        relativeTiming: 0.1,
        ...(steps === undefined ? {} : { steps }),
      },
    ],
    verdict: "pass" as const,
  };
}

describe("harden: per-step budgets", () => {
  it("H27 a zero-cost interaction always passes", () => {
    expect(computeVerdict(stepCombo(0, 1) as never, DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T1 })).toBe("pass");
  });

  it("H28 a missing or negative event count means one event", () => {
    expect(perStepCost({ timing: { median: 110 } } as never)).toBeCloseTo(110, 5);
    expect(perStepCost({ timing: { median: 110 }, steps: -5 } as never)).toBeCloseTo(110, 5);
  });

  it("H29 T1 is stricter than T4 for the same interaction", () => {
    // 40ms per event: inside T4's 100ms frame budget, outside T1's 33ms.
    const c = stepCombo(40 * 11, 11);
    expect(computeVerdict(c as never, DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T1 })).toBe("fail");
    expect(computeVerdict(c as never, DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T4 })).toBe("pass");
  });

  it("H30 a combo with no interactions is unaffected", () => {
    const c = { ...stepCombo(0, 1), interactions: [] };
    expect(computeVerdict(c as never, DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T1 })).toBe("pass");
  });
});
