import { describe, it, expect } from "vitest";
import { detectScalingProps } from "../../src/prop-gen.js";
import { generateScalingCombos } from "../../src/prop-gen-values.js";
import { parseArgs } from "../../src/cli.js";
import { formatTable, type Report } from "../../src/report.js";
import type { PropSchema, ScalingPropMatch } from "../../src/prop-gen.js";

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00Z",
    machine: { cpu: "test", cores: 4, ramMb: 16384, os: "test", nodeVersion: "v20.0.0", chromiumVersion: "120" },
    componentPath: "./test.tsx",
    componentName: "Test",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos: [{
      comboIndex: 0,
      props: {},
      mount: { samples: [5], median: 5, p95: 5, cv: 0, unstable: false },
      unmount: { samples: [2], median: 2, p95: 2, cv: 0, unstable: false },
      rerender: { samples: [3], median: 3, p95: 3, cv: 0, unstable: false },
      domNodeCount: 10,
      heapDelta: 0,
      interactions: [],
      scalingCurve: null,
      relativeMount: 0.5,
      verdict: "pass",
    }],
    thresholds: { mountMs: 16, interactionMs: 100, relativeMount: 2, rerenderMs: 8 },
    pass: true,
    ...overrides,
  };
}

describe("H1: empty schemas", () => {
  it("returns empty", () => {
    expect(detectScalingProps([])).toHaveLength(0);
  });
});

describe("H2: non-scaling number prop", () => {
  it("opacity is not detected", () => {
    const schemas: PropSchema[] = [
      { name: "opacity", kind: "number", required: true, values: [] },
    ];
    expect(detectScalingProps(schemas)).toHaveLength(0);
  });

  it("width is not detected", () => {
    const schemas: PropSchema[] = [
      { name: "width", kind: "number", required: true, values: [] },
    ];
    expect(detectScalingProps(schemas)).toHaveLength(0);
  });

  it("delay is not detected", () => {
    const schemas: PropSchema[] = [
      { name: "delay", kind: "number", required: true, values: [] },
    ];
    expect(detectScalingProps(schemas)).toHaveLength(0);
  });
});

describe("H3: items-like name but wrong kind", () => {
  it("items as string → not detected", () => {
    const schemas: PropSchema[] = [
      { name: "items", kind: "string", required: true, values: [] },
    ];
    expect(detectScalingProps(schemas)).toHaveLength(0);
  });

  it("count as boolean → not detected", () => {
    const schemas: PropSchema[] = [
      { name: "count", kind: "boolean", required: true, values: [] },
    ];
    expect(detectScalingProps(schemas)).toHaveLength(0);
  });
});

describe("H4: multiple array props — items-like wins", () => {
  it("options beats random", () => {
    const schemas: PropSchema[] = [
      { name: "random", kind: "array", required: true, values: [] },
      { name: "options", kind: "array", required: true, values: [] },
    ];
    const matches = detectScalingProps(schemas);
    expect(matches[0].schema.name).toBe("options");
  });
});

describe("H5: n vs name — false positive", () => {
  it("n matches shorthand", () => {
    const schemas: PropSchema[] = [
      { name: "n", kind: "number", required: true, values: [] },
    ];
    expect(detectScalingProps(schemas)).toHaveLength(1);
  });

  it("name does NOT match shorthand (^n$ requires exact)", () => {
    const schemas: PropSchema[] = [
      { name: "name", kind: "number", required: true, values: [] },
    ];
    const matches = detectScalingProps(schemas);
    // "name" doesn't match ^n$ or ^num, and doesn't match scaling pattern
    expect(matches).toHaveLength(0);
  });
});

describe("H6: numRows matches ^num", () => {
  it("numRows detected as numeric shorthand", () => {
    const schemas: PropSchema[] = [
      { name: "numRows", kind: "number", required: true, values: [] },
    ];
    const matches = detectScalingProps(schemas);
    expect(matches).toHaveLength(1);
    // numRows also matches "rows" in SCALING_NAME_PATTERN
    expect(matches[0].kind).toBe("numeric");
  });
});

describe("H7: compound scaling name", () => {
  it("maxCount matches scaling pattern", () => {
    const schemas: PropSchema[] = [
      { name: "maxCount", kind: "number", required: true, values: [] },
    ];
    const matches = detectScalingProps(schemas);
    expect(matches).toHaveLength(1);
    expect(matches[0].reason).toBe("numeric prop name matches scaling pattern");
  });

  it("totalPages matches scaling pattern", () => {
    const schemas: PropSchema[] = [
      { name: "totalPages", kind: "number", required: true, values: [] },
    ];
    const matches = detectScalingProps(schemas);
    expect(matches).toHaveLength(1);
  });
});

describe("H8: single scaling prop, no other props", () => {
  it("generates combos with only the scaling prop", () => {
    const schemas: PropSchema[] = [
      { name: "count", kind: "number", required: true, values: [1] },
    ];
    const match: ScalingPropMatch = { schema: schemas[0], kind: "numeric", reason: "test" };
    const combos = generateScalingCombos(schemas, match, [1, 10]);
    expect(combos).toHaveLength(2);
    expect(combos[0]).toEqual({ count: 1 });
    expect(combos[1]).toEqual({ count: 10 });
  });
});

describe("H9: zero scale points", () => {
  it("returns empty array", () => {
    const schemas: PropSchema[] = [
      { name: "count", kind: "number", required: true, values: [1] },
    ];
    const match: ScalingPropMatch = { schema: schemas[0], kind: "numeric", reason: "test" };
    const combos = generateScalingCombos(schemas, match, []);
    expect(combos).toHaveLength(0);
  });
});

describe("H10: --no-auto-scale alongside --scale", () => {
  it("both flags parsed correctly", () => {
    const args = parseArgs(["./B.tsx", "--no-auto-scale", "--scale", "1,10,100"]);
    expect(args.noAutoScale).toBe(true);
    expect(args.scale).toEqual([1, 10, 100]);
    expect(args.error).toBeUndefined();
  });
});

describe("H12: partial match on items-like name", () => {
  it("optionsProvider matches items-like pattern (contains 'options')", () => {
    const schemas: PropSchema[] = [
      { name: "optionsProvider", kind: "array", required: true, values: [] },
    ];
    const matches = detectScalingProps(schemas);
    // The regex tests /options/i which matches substring
    expect(matches).toHaveLength(1);
    expect(matches[0].reason).toBe("array prop with items-like name");
  });
});

describe("H13: union kind with scaling name", () => {
  it("count as union → not detected", () => {
    const schemas: PropSchema[] = [
      { name: "count", kind: "union", required: true, values: [1, 2, 3] },
    ];
    expect(detectScalingProps(schemas)).toHaveLength(0);
  });

  it("items as object → not detected", () => {
    const schemas: PropSchema[] = [
      { name: "items", kind: "object", required: true, values: [{}] },
    ];
    expect(detectScalingProps(schemas)).toHaveLength(0);
  });
});

describe("H14: mixed array + numeric", () => {
  it("array takes priority over numeric", () => {
    const schemas: PropSchema[] = [
      { name: "count", kind: "number", required: true, values: [] },
      { name: "stuff", kind: "array", required: true, values: [] },
    ];
    const matches = detectScalingProps(schemas);
    expect(matches[0].schema.name).toBe("stuff");
    expect(matches[0].kind).toBe("array");
  });
});

describe("H15: formatTable with autoScalingProp but no scaling curve", () => {
  it("does not show auto label when no curve", () => {
    const report = makeReport({
      autoScalingProp: "items",
      autoScalingReason: "array prop with items-like name",
      combos: [{
        comboIndex: 0,
        props: {},
        mount: { samples: [5], median: 5, p95: 5, cv: 0, unstable: false },
        unmount: { samples: [2], median: 2, p95: 2, cv: 0, unstable: false },
        rerender: { samples: [3], median: 3, p95: 3, cv: 0, unstable: false },
        domNodeCount: 10,
        heapDelta: 0,
        interactions: [],
        scalingCurve: null,
        relativeMount: 0.5,
        verdict: "pass",
      }],
    });
    const output = formatTable(report);
    // No scaling curve → scaling column shows "-", no auto suffix
    expect(output).not.toContain("auto: items");
  });
});
