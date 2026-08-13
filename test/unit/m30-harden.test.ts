import { describe, it, expect } from "vitest";
import { extractProps, type PropSchema } from "../../src/prop-gen.js";
import { fillArray, generateCombinations } from "../../src/prop-gen-values.js";
import { selectExploreCombos } from "../../src/explorer.js";
import { isDomFlat } from "../../src/metrics.js";
import { isContextLostError } from "../../src/measure.js";
import { shouldRollbackComposition } from "../../src/composition.js";
import { computeVerdict, DEFAULT_THRESHOLDS, TIER_BUDGETS, perStepCost } from "../../src/report.js";

const EDGES = "./fixtures/m30-array-edges.tsx";

let cached: PropSchema[] | undefined;
async function props(): Promise<PropSchema[]> {
  if (!cached) cached = await extractProps(EDGES);
  return cached;
}

function get(all: PropSchema[], name: string): PropSchema {
  const found = all.find((p) => p.name === name);
  if (!found) throw new Error(`no schema for ${name}`);
  return found;
}

// H1-H9: element synthesis across array shapes that are easy to get wrong.
describe("m30 harden — array element synthesis", () => {
  it("H1 readonly array yields a primitive element", async () => {
    expect(get(await props(), "frozen").elementTemplate).toBe("text");
  });

  it("H2 a tuple is not an array prop and gets no element template", async () => {
    const pair = get(await props(), "pair");
    expect(pair.kind).toBe("object");
    expect(pair.elementTemplate).toBeUndefined();
  });

  it("H3 union of primitives takes the first member", async () => {
    expect(get(await props(), "mixed").elementTemplate).toBe("text");
  });

  it("H4 nested array yields a one-element inner array", async () => {
    expect(get(await props(), "grid").elementTemplate).toEqual([{ x: 1, y: 1 }]);
  });

  it("H5 unknown[] falls back to the string element", async () => {
    const loose = get(await props(), "loose");
    expect(loose.elementTemplate).toBeUndefined();
    expect(fillArray(loose, 2)).toEqual(["item-1", "item-2"]);
  });

  it("H6 optional array is still synthesized", async () => {
    expect(get(await props(), "maybe").elementTemplate).toEqual({ x: 1, y: 1 });
  });

  it("H7 boolean array yields a boolean element", async () => {
    expect(get(await props(), "flags").elementTemplate).toBe(true);
  });

  it("H8 literal union array takes the first literal", async () => {
    expect(get(await props(), "literals").elementTemplate).toBe("a");
  });

  it("H9 an element type with no properties falls back rather than emitting {}", async () => {
    const empty = get(await props(), "empty");
    expect(empty.elementTemplate).toBeUndefined();
    expect(fillArray(empty, 2)).toEqual(["item-1", "item-2"]);
  });

  it("H10 every array prop stays generatable end to end", async () => {
    const all = await props();
    expect(() => generateCombinations(all)).not.toThrow();
    expect(generateCombinations(all).length).toBeGreaterThan(0);
  });

  it("H11 fillArray(0) is empty", async () => {
    expect(fillArray(get(await props(), "grid"), 0)).toEqual([]);
  });

  it("H12 clones are deep, not shared references", async () => {
    const filled = fillArray(get(await props(), "grid"), 2) as unknown[][];
    expect(filled[0]).not.toBe(filled[1]);
    expect(filled[0][0]).not.toBe(filled[1][0]);
  });
});

// H13-H17: budget selection under awkward counts.
describe("m30 harden — explore combo selection", () => {
  it("H13 cap equal to count returns everything", () => {
    expect(selectExploreCombos(8, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("H14 cap one below count still keeps both ends", () => {
    const picked = selectExploreCombos(9, 8);
    expect(picked[0]).toBe(0);
    expect(picked[picked.length - 1]).toBe(8);
  });

  it("H15 two picks are the two ends", () => {
    expect(selectExploreCombos(50, 2)).toEqual([0, 49]);
  });

  it("H16 negative count is empty, not a crash", () => {
    expect(selectExploreCombos(-1, 8)).toEqual([]);
  });

  it("H17 never picks an out-of-range index", () => {
    for (const n of [3, 7, 27, 64, 101]) {
      for (const k of [1, 2, 5, 8]) {
        for (const idx of selectExploreCombos(n, k)) {
          expect(idx).toBeGreaterThanOrEqual(0);
          expect(idx).toBeLessThan(n);
        }
      }
    }
  });
});

// H18-H21: guards that must not fire on legitimate data.
describe("m30 harden — guards", () => {
  it("H18 a growing DOM is never flat", () => {
    expect(isDomFlat([{ n: 1, domNodeCount: 9 }, { n: 2, domNodeCount: 10 }])).toBe(false);
  });

  it("H19 all-unknown node counts are not flat", () => {
    expect(isDomFlat([{ n: 1 }, { n: 2 }])).toBe(false);
  });

  it("H20 a rendered composed scene is kept even with one element", () => {
    expect(shouldRollbackComposition({ rootElements: 1 })).toBe(false);
  });

  it("H21 a negative element count rolls back", () => {
    expect(shouldRollbackComposition({ rootElements: -1 })).toBe(true);
  });

  it("H22 a null error field does not force a rollback", () => {
    expect(shouldRollbackComposition({ rootElements: 5, error: null })).toBe(false);
  });
});

// H23-H26: retry detection must not swallow real component failures.
describe("m30 harden — context loss detection", () => {
  it("H23 a component render error is not a lost context", () => {
    expect(isContextLostError(new Error("Cannot read properties of undefined (reading 'map')"))).toBe(false);
  });

  it("H24 a missing selector is not a lost context", () => {
    expect(isContextLostError(new Error("locator.click: Timeout 3000ms exceeded"))).toBe(false);
  });

  it("H25 a non-Error object is not a lost context", () => {
    expect(isContextLostError({ message: "Execution context was destroyed" })).toBe(false);
  });

  it("H26 calibration failure is not a lost context", () => {
    expect(isContextLostError(new Error("Calibration produced zero duration"))).toBe(false);
  });
});

// H27-H30: per-step normalization at the boundaries.
function combo(median: number, steps?: number) {
  const timing = { samples: [median], median, p95: median, cv: 0, unstable: false };
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
        timing,
        relativeTiming: 0.1,
        ...(steps === undefined ? {} : { steps }),
      },
    ],
    verdict: "pass" as const,
  };
}

describe("m30 harden — per-step budgets", () => {
  it("H27 a zero-cost interaction always passes", () => {
    expect(computeVerdict(combo(0, 1) as never, DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T1 })).toBe("pass");
  });

  it("H28 a missing or negative event count means one event", () => {
    expect(perStepCost({ timing: { median: 110 } } as never)).toBeCloseTo(110, 5);
    expect(perStepCost({ timing: { median: 110 }, steps: -5 } as never)).toBeCloseTo(110, 5);
  });

  it("H29 T1 is stricter than T4 for the same interaction", () => {
    // 40ms per event: inside T4's 100ms frame budget, outside T1's 33ms.
    const c = combo(40 * 11, 11);
    expect(computeVerdict(c as never, DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T1 })).toBe("fail");
    expect(computeVerdict(c as never, DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T4 })).toBe("pass");
  });

  it("H30 a combo with no interactions is unaffected", () => {
    const c = { ...combo(0, 1), interactions: [] };
    expect(computeVerdict(c as never, DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T1 })).toBe("pass");
  });
});
