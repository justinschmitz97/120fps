import { describe, it, expect } from "vitest";
import path from "node:path";
import { measureGatedScaleMounts } from "../../src/pipeline/index.js";
import { generateEntry, generateVueEntry } from "../../src/harness/index.js";
import { extractProps, generateCombinations } from "../../src/props/index.js";
import type { MountResult, PropCombination } from "../../src/browser/index.js";

const FIXTURE = path.resolve(__dirname, "../../fixtures/m134-required-icon/RequiredIcon.tsx");

function mountResult(comboIndex: number, props: PropCombination): MountResult {
  return {
    comboIndex,
    props,
    mount: { samples: [5], median: 5, p95: 5 },
    unmount: { samples: [1], median: 1, p95: 1 },
    domNodeCount: 8,
    heapDelta: 0,
  };
}

function recordingMeasure() {
  const batches: PropCombination[][] = [];
  return {
    batches,
    measure: async (combos: PropCombination[]) => {
      batches.push(combos);
      return combos.map((props, ci) => mountResult(ci, props));
    },
  };
}

const scaleRows = (combos: PropCombination[]): PropCombination[] =>
  combos.filter((c) => "__120fps_scaleN" in c);

describe("the props an auto-scale probe mounts its copies with", () => {
  it("carries the first measured combo's prop set beside the copy count", async () => {
    const { measure } = recordingMeasure();
    const base = { icon: "IconStub", title: "Nothing here" };

    const result = await measureGatedScaleMounts({
      propCombos: [base, { icon: "IconStub", title: "" }],
      scalePoints: [1, 5, 20, 50],
      measure,
    });

    expect(scaleRows(result.combos)).toEqual([
      { ...base, __120fps_scaleN: 1 },
      { ...base, __120fps_scaleN: 5 },
      { ...base, __120fps_scaleN: 20 },
      { ...base, __120fps_scaleN: 50 },
    ]);
  });

  it("keeps the bare trigger for a run that has no prop combos of its own", async () => {
    const { measure } = recordingMeasure();

    const result = await measureGatedScaleMounts({
      propCombos: [],
      scalePoints: [1, 5],
      measure,
    });

    expect(result.combos).toEqual([{ __120fps_scaleN: 1 }, { __120fps_scaleN: 5 }]);
  });

  it("still reports the copy count as the row's identity, never as one of its props", async () => {
    const { measure } = recordingMeasure();

    const result = await measureGatedScaleMounts({
      propCombos: [{ title: "x" }],
      scalePoints: [1, 5],
      measure,
    });

    for (const row of scaleRows(result.combos)) {
      expect(typeof row.__120fps_scaleN).toBe("number");
      expect(row.title).toBe("x");
    }
    expect(result.combos.filter((c) => !("__120fps_scaleN" in c))).toEqual([{ title: "x" }]);
  });

  it("gives every copy of a component with a required prop a value for it", async () => {
    const { measure } = recordingMeasure();
    const schemas = await extractProps(FIXTURE);
    const propCombos = generateCombinations(schemas);

    expect(schemas.some((s) => s.name === "icon" && s.required)).toBe(true);
    expect(propCombos.length).toBeGreaterThan(0);

    const result = await measureGatedScaleMounts({
      propCombos,
      scalePoints: [1, 5, 20, 50],
      measure,
    });

    const rows = scaleRows(result.combos);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.icon).toBeDefined();
      expect(row.icon).toEqual(propCombos[0].icon);
    }
  });
});

describe("the copies the harness entry fans out", () => {
  const opts = {
    componentRelative: "./RequiredIcon.tsx",
    componentName: "RequiredIcon",
    isDefaultExport: false,
  };

  it("mounts each React copy with the props the combo carried", () => {
    const entry = generateEntry(opts);
    expect(entry).toContain("const { __120fps_scaleN: _, ...restProps } = props;");
    expect(entry).toContain("{ ...restProps, key: i }");
  });

  it("mounts each Vue copy with the props the combo carried", () => {
    const entry = generateVueEntry(opts);
    expect(entry).toContain("const { __120fps_scaleN: _n, ...rest } = props;");
    expect(entry).toContain("{ ...rest, key: i }");
  });
});
