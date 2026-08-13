import { describe, it, expect } from "vitest";
import { countPatternEvents, resolveStressPattern } from "../../src/stress-patterns.js";
import {
  computeVerdict,
  DEFAULT_THRESHOLDS,
  TIER_BUDGETS,
  REFERENCE_EVENTS,
  type ComboReport,
  type InteractionReport,
} from "../../src/report.js";
import type { InteractionDescriptor } from "../../src/discovery.js";

function descriptor(over: Partial<InteractionDescriptor> = {}): InteractionDescriptor {
  return { selector: "button", type: "click", label: "x", tagName: "BUTTON", ...over } as InteractionDescriptor;
}

describe("m33 E1 — the unit is one event", () => {
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

function timing(median: number) {
  return { samples: [median], median, p95: median, cv: 0, unstable: false };
}

function combo(median: number, steps: number): ComboReport {
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

describe("m33 E2 — the budget is a frame", () => {
  it("derives tier budgets from frame times under 4x throttle", () => {
    expect(TIER_BUDGETS.T1.interactionStepMs).toBe(33);
    expect(TIER_BUDGETS.T2.interactionStepMs).toBe(50);
    expect(TIER_BUDGETS.T3.interactionStepMs).toBe(67);
    expect(TIER_BUDGETS.T4.interactionStepMs).toBe(100);
    expect(DEFAULT_THRESHOLDS.interactionStepMs).toBe(67);
  });

  // Values below are measured per-event costs from the dogfooding repos.
  it("passes a Button with loading and spotlight at T3 (39.2ms/event)", () => {
    expect(computeVerdict(combo(431, 11), DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T3 })).toBe("pass");
  });

  it("fails the same interaction at T1, where a 120fps frame is the budget", () => {
    expect(computeVerdict(combo(431, 11), DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T1 })).toBe("fail");
  });

  it("passes a 60-move comparison drag (20.8ms/event)", () => {
    expect(computeVerdict(combo(1249, 60), DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T3 })).toBe("pass");
  });

  it("fails a whole-application interaction (205.9ms/event)", () => {
    expect(computeVerdict(combo(2265, 11), DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T3 })).toBe("fail");
  });

  it("passes a cheap component interaction (8.6ms/event)", () => {
    expect(computeVerdict(combo(95, 11), DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T1 })).toBe("pass");
  });

  it("treats a missing event count as one event", () => {
    const c = combo(100, 1);
    delete (c.interactions[0] as { steps?: number }).steps;
    expect(computeVerdict(c, DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T3 })).toBe("fail");
  });

  it("keeps an explicit --threshold-interaction on its aggregate meaning", () => {
    expect(REFERENCE_EVENTS).toBe(11);
    const flat = { ...DEFAULT_THRESHOLDS, interactionMs: 110 };
    // 110ms over 11 reference events is a 10ms per-event budget.
    expect(computeVerdict(combo(99, 11), flat, { explicitInteraction: true })).toBe("pass");
    expect(computeVerdict(combo(121, 11), flat, { explicitInteraction: true })).toBe("fail");
  });
});

import { isContextLostError, refreshCdpSession, type CdpHolder } from "../../src/measure.js";

describe("m33 E4 — a wedged tracing session is recoverable", () => {
  it("classifies a tracing timeout as retryable again", () => {
    expect(isContextLostError(new Error("Tracing.tracingComplete timed out"))).toBe(true);
  });

  it("replaces the session and detaches the old one", async () => {
    let detached = 0;
    const created: object[] = [];
    const holder: CdpHolder = { cdp: { detach: async () => { detached++; } } as never };
    const page = {
      context: () => ({
        newCDPSession: async () => {
          const s = { id: created.length } as never;
          created.push(s);
          return s;
        },
      }),
    } as never;

    await refreshCdpSession(page, holder);
    expect(detached).toBe(1);
    expect(holder.cdp).toBe(created[0]);
  });

  it("still replaces the session when detaching the old one throws", async () => {
    const holder: CdpHolder = {
      cdp: { detach: async () => { throw new Error("already gone"); } } as never,
    };
    const fresh = {} as never;
    const page = { context: () => ({ newCDPSession: async () => fresh }) } as never;

    await refreshCdpSession(page, holder);
    expect(holder.cdp).toBe(fresh);
  });
});
