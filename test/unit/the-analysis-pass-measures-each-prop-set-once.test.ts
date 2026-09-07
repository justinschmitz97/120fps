import { describe, it, expect } from "vitest";
import { measureOncePerPropSet, propCombinationKey } from "../../src/analysis/index.js";
import type { PropCombination } from "../../src/props/index.js";

const scale = (n: number): PropCombination => ({ __120fps_scaleN: n });

// The per-combo loop of a run measured with --max-combos 2 over a component with scale points.
const RUN_COMBOS: PropCombination[] = [
  { variant: "primary" },
  { variant: "ghost" },
  scale(1),
  scale(5),
  scale(20),
  scale(50),
];

async function perComboPass<T>(
  combos: PropCombination[],
  measure: (props: PropCombination, comboIndex: number) => Promise<T>,
): Promise<Map<number, T>> {
  const results = new Map<number, T>();
  for (let ci = 0; ci < combos.length; ci++) results.set(ci, await measure(combos[ci], ci));
  return results;
}

describe("the React analysis pass over a run's combo list", () => {
  it("measures each distinct prop set once", async () => {
    const measured: PropCombination[] = [];
    await measureOncePerPropSet(RUN_COMBOS, async (props) => {
      measured.push(props);
      return props;
    });

    expect(measured).toEqual([{ variant: "primary" }, { variant: "ghost" }, scale(1)]);
  });

  it("attributes the shared measurement to every combo that shares the prop set", async () => {
    const results = await measureOncePerPropSet(RUN_COMBOS, async (_props, ci) => ({ measuredAt: ci }));

    expect([...results.keys()]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(results.get(2)).toEqual({ measuredAt: 2 });
    expect(results.get(3)).toEqual({ measuredAt: 2 });
    expect(results.get(4)).toEqual({ measuredAt: 2 });
    expect(results.get(5)).toEqual({ measuredAt: 2 });
  });

  it("measures two combos with genuinely different props separately", async () => {
    const measured: PropCombination[] = [];
    const results = await measureOncePerPropSet(
      [{ size: "sm" }, { size: "lg" }],
      async (props) => {
        measured.push(props);
        return props;
      },
    );

    expect(measured).toHaveLength(2);
    expect(results.get(0)).not.toEqual(results.get(1));
  });

  it("returns what the per-combo pass returned when every prop set is distinct", async () => {
    const combos: PropCombination[] = [{ a: 1 }, { a: 2 }, { a: 3 }];
    const measure = async (props: PropCombination, ci: number) => ({ props, ci });

    expect([...(await measureOncePerPropSet(combos, measure)).entries()]).toEqual(
      [...(await perComboPass(combos, measure)).entries()],
    );
  });

  it("shares one measurement across the scale combos the probe cannot tell apart", () => {
    expect(propCombinationKey(scale(1))).toBe(propCombinationKey(scale(50)));
    expect(propCombinationKey({})).toBe(propCombinationKey(scale(5)));
    expect(propCombinationKey({ variant: "primary" })).not.toBe(propCombinationKey({}));
  });

  it("measures nothing for an empty combo list", async () => {
    let calls = 0;
    const results = await measureOncePerPropSet([], async () => {
      calls += 1;
      return null;
    });

    expect(calls).toBe(0);
    expect(results.size).toBe(0);
  });
});
