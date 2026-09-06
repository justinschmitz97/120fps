import { describe, it, expect } from "vitest";
import {
  computeVerdict,
  withholdInteractionFailsUnderHostileNoise,
  INTERACTION_FAIL_WITHHELD_WARNING,
  DEFAULT_THRESHOLDS,
  TIER_BUDGETS,
  type ComboReport,
  type InteractionReport,
  type Report,
} from "../../src/report/index.js";
import type { NoiseLevel } from "../../src/browser/index.js";

function timing(median: number, unstable: boolean) {
  return { samples: [median], median, p95: median, cv: unstable ? 80 : 2, unstable };
}

function interaction(median: number, unstable: boolean): InteractionReport {
  return {
    label: "Bluesky",
    type: "click",
    selector: "ul > li:nth-of-type(4) > a",
    timing: timing(median, unstable),
    relativeTiming: 1,
    steps: 11,
  } as InteractionReport;
}

function combo(overrides: Partial<ComboReport> = {}): ComboReport {
  return {
    comboIndex: 0,
    props: {},
    mount: timing(4, false),
    unmount: timing(2, false),
    rerender: timing(4, false),
    relativeMount: 0.01,
    domNodeCount: 6,
    interactions: [],
    tier: "T1",
    verdict: "pass",
    ...overrides,
  } as ComboReport;
}

function report(level: NoiseLevel, combos: ComboReport[]): Report {
  return {
    version: 1,
    timestamp: "2026-09-06T00:00:00.000Z",
    componentPath: "src/components/HelloWorld.vue",
    componentName: "HelloWorld",
    combos,
    thresholds: DEFAULT_THRESHOLDS,
    pass: combos.every((c) => c.verdict !== "fail"),
    noise: {
      level,
      signals: { probeCv: 32.8, probeMedianMs: 1.7, unstableFraction: 0.13, contextRetries: 0 },
    },
  } as Report;
}

// 2366ms over 11 clicks is 215ms per step against T1's 33ms budget.
const BREACH = 2366;

describe("a threshold breach the machine could not repeat identically", () => {
  it("warns when the samples are unstable and the machine is hostile", () => {
    const c = combo({ interactions: [interaction(BREACH, true)] });
    expect(
      computeVerdict(c, DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T1, noiseLevel: "hostile" }),
    ).toBe("warn");
  });

  it("still fails on a machine the sentinel only calls noisy", () => {
    const c = combo({ interactions: [interaction(BREACH, true)] });
    expect(
      computeVerdict(c, DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T1, noiseLevel: "noisy" }),
    ).toBe("fail");
  });

  it("still fails when the samples agreed with each other", () => {
    const c = combo({ interactions: [interaction(BREACH, false)] });
    expect(
      computeVerdict(c, DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T1, noiseLevel: "hostile" }),
    ).toBe("fail");
  });

  it("leaves a mount breach failing, whatever the machine was doing", () => {
    const c = combo({ mount: timing(400, true), interactions: [interaction(BREACH, true)] });
    expect(
      computeVerdict(c, DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T1, noiseLevel: "hostile" }),
    ).toBe("fail");
  });

  it("leaves the pass and warn paths where they were", () => {
    expect(
      computeVerdict(combo(), DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T1, noiseLevel: "hostile" }),
    ).toBe("pass");
    const jittery = combo({ interactions: [interaction(10, true)] });
    expect(
      computeVerdict(jittery, DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T1, noiseLevel: "hostile" }),
    ).toBe("warn");
  });
});

describe("the report says a FAIL was withheld rather than hiding it", () => {
  it("downgrades the combo, flips the run to passing and names the interaction", () => {
    const c = combo({ verdict: "fail", interactions: [interaction(BREACH, true)] });
    const r = report("hostile", [c]);
    const warning = withholdInteractionFailsUnderHostileNoise(r);
    expect(c.verdict).toBe("warn");
    expect(r.pass).toBe(true);
    expect(warning).toBe(INTERACTION_FAIL_WITHHELD_WARNING(32.8, ["Bluesky"]));
    expect(warning).toMatch(/withheld/);
  });

  it("keeps the unsuppressed classification in the JSON for both halves", () => {
    const c = combo({ verdict: "fail", interactions: [interaction(BREACH, true)] });
    const r = report("hostile", [c]);
    withholdInteractionFailsUnderHostileNoise(r);
    expect(r.combos[0].interactions[0].timing.unstable).toBe(true);
    expect(r.noise!.level).toBe("hostile");
  });

  it("withholds nothing on a machine the sentinel only calls noisy", () => {
    const c = combo({ verdict: "fail", interactions: [interaction(BREACH, true)] });
    const r = report("noisy", [c]);
    expect(withholdInteractionFailsUnderHostileNoise(r)).toBeUndefined();
    expect(c.verdict).toBe("fail");
    expect(r.pass).toBe(false);
  });

  it("withholds nothing when the breaching samples agreed with each other", () => {
    const c = combo({ verdict: "fail", interactions: [interaction(BREACH, false)] });
    const r = report("hostile", [c]);
    expect(withholdInteractionFailsUnderHostileNoise(r)).toBeUndefined();
    expect(c.verdict).toBe("fail");
  });

  it("leaves a fail no interaction explains alone", () => {
    const c = combo({ verdict: "fail", mount: timing(400, true), interactions: [] });
    const r = report("hostile", [c]);
    expect(withholdInteractionFailsUnderHostileNoise(r)).toBeUndefined();
    expect(c.verdict).toBe("fail");
  });

  it("leaves a render failure failing", () => {
    const c = combo({
      verdict: "fail",
      renderHealth: "error",
      domNodeCount: 0,
      interactions: [interaction(BREACH, true)],
    });
    const r = report("hostile", [c]);
    expect(withholdInteractionFailsUnderHostileNoise(r)).toBeUndefined();
    expect(c.verdict).toBe("fail");
  });

  it("withholds nothing from a run the sentinel never classified", () => {
    const c = combo({ verdict: "fail", interactions: [interaction(BREACH, true)] });
    const r = report("hostile", [c]);
    delete r.noise;
    expect(withholdInteractionFailsUnderHostileNoise(r)).toBeUndefined();
    expect(c.verdict).toBe("fail");
  });

  it("withholds nothing from a report that measured no combos", () => {
    expect(withholdInteractionFailsUnderHostileNoise(report("hostile", []))).toBeUndefined();
  });

  it("falls back to the tightest tier when the combo carries none", () => {
    const c = combo({ verdict: "fail", tier: undefined, interactions: [interaction(BREACH, true)] });
    const r = report("hostile", [c]);
    expect(withholdInteractionFailsUnderHostileNoise(r)).toBeDefined();
    expect(c.verdict).toBe("warn");
  });

  it("names the selector when the interaction had no accessible label", () => {
    const bare = { ...interaction(BREACH, true), label: "" };
    const c = combo({ verdict: "fail", interactions: [bare] });
    const r = report("hostile", [c]);
    expect(withholdInteractionFailsUnderHostileNoise(r)).toBe(
      INTERACTION_FAIL_WITHHELD_WARNING(32.8, ["ul > li:nth-of-type(4) > a"]),
    );
  });

  it("does not raise a run that still has another failing combo", () => {
    const withheld = combo({ verdict: "fail", interactions: [interaction(BREACH, true)] });
    const broken = combo({ comboIndex: 1, verdict: "fail", mount: timing(400, false) });
    const r = report("hostile", [withheld, broken]);
    expect(withholdInteractionFailsUnderHostileNoise(r)).toBeDefined();
    expect(withheld.verdict).toBe("warn");
    expect(broken.verdict).toBe("fail");
    expect(r.pass).toBe(false);
  });
});
