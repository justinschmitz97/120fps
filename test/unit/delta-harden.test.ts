import { describe, it, expect } from "vitest";
import { generateDeltaPairs } from "../../src/prop-gen-values.js";
import { formatTable, type Report, type PropDelta } from "../../src/report.js";
import type { PropSchema } from "../../src/prop-gen.js";

describe("generateDeltaPairs hardening", () => {
  it("H1: boolean anchor is false, not the first resolveValues entry", () => {
    const schemas: PropSchema[] = [
      { name: "open", kind: "boolean", required: true, values: [] },
    ];
    const pairs = generateDeltaPairs(schemas);
    expect(pairs[0].baseCombo.open).toBe(false);
    expect(pairs[0].flipCombo.open).toBe(true);
  });

  it("H2: union with single value produces 0 pairs", () => {
    const schemas: PropSchema[] = [
      { name: "size", kind: "union", required: true, values: ["medium"] },
    ];
    const pairs = generateDeltaPairs(schemas);
    expect(pairs).toHaveLength(0);
  });

  it("H3: string, number, array props produce no pairs", () => {
    const schemas: PropSchema[] = [
      { name: "title", kind: "string", required: true, values: ["hello"] },
      { name: "count", kind: "number", required: true, values: [1, 2, 3] },
      { name: "items", kind: "array", required: true, values: [] },
    ];
    const pairs = generateDeltaPairs(schemas);
    expect(pairs).toHaveLength(0);
  });

  it("H4: optional boolean generates pair with anchor at false", () => {
    const schemas: PropSchema[] = [
      { name: "visible", kind: "boolean", required: false, values: [] },
    ];
    const pairs = generateDeltaPairs(schemas);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].baseValue).toBe(false);
    expect(pairs[0].flipValue).toBe(true);
  });

  it("H5: multiple unions sorted by value count ascending", () => {
    const schemas: PropSchema[] = [
      { name: "size", kind: "union", required: true, values: ["sm", "md", "lg", "xl"] },
      { name: "color", kind: "union", required: true, values: ["red", "blue"] },
    ];
    const pairs = generateDeltaPairs(schemas);
    const colorIdx = pairs.findIndex((p) => p.propName === "color");
    const sizeIdx = pairs.findIndex((p) => p.propName === "size");
    expect(colorIdx).toBeLessThan(sizeIdx);
  });

  it("H6: exactly 128 boolean props produces exactly 128 pairs", () => {
    const schemas: PropSchema[] = [];
    for (let i = 0; i < 128; i++) {
      schemas.push({ name: `b${i}`, kind: "boolean", required: true, values: [] });
    }
    const pairs = generateDeltaPairs(schemas);
    expect(pairs).toHaveLength(128);
  });

  it("H7: 129 boolean props caps at 128", () => {
    const schemas: PropSchema[] = [];
    for (let i = 0; i < 129; i++) {
      schemas.push({ name: `b${i}`, kind: "boolean", required: true, values: [] });
    }
    const pairs = generateDeltaPairs(schemas);
    expect(pairs).toHaveLength(128);
  });

  it("H8: object prop with empty values uses {} as flip", () => {
    const schemas: PropSchema[] = [
      { name: "style", kind: "object", required: false, values: [] },
    ];
    const pairs = generateDeltaPairs(schemas);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].baseValue).toBe(undefined);
    expect(pairs[0].flipValue).toEqual({});
  });
});

describe("formatTable propDeltas hardening", () => {
  function makeReport(propDeltas?: PropDelta[]): Report {
    return {
      version: 1,
      timestamp: "2026-01-01T00:00:00Z",
      machine: { cpu: "test", cores: 4, ramMb: 16384, os: "test", nodeVersion: "v20.0.0", chromiumVersion: "120" },
      componentPath: "./test.tsx",
      componentName: "Test",
      calibration: { totalDuration: 10, scriptDuration: 5 },
      combos: [{
        comboIndex: 0, props: {},
        mount: { samples: [5], median: 5, p95: 5, cv: 0, unstable: false },
        unmount: { samples: [2], median: 2, p95: 2, cv: 0, unstable: false },
        rerender: { samples: [3], median: 3, p95: 3, cv: 0, unstable: false },
        domNodeCount: 10, heapDelta: 0, interactions: [],
        scalingCurve: null, relativeMount: 0.5, verdict: "pass",
      }],
      thresholds: { mountMs: 16, interactionMs: 100, relativeMount: 2, rerenderMs: 8 },
      pass: true,
      propDeltas,
    };
  }

  it("H9: negative mountDelta shows minus sign", () => {
    const report = makeReport([
      { propName: "lazy", baseValue: false, flipValue: true, mountDelta: -0.3, rerenderDelta: -0.1 },
    ]);
    const output = formatTable(report);
    expect(output).toContain("-0.30ms");
    expect(output).toContain("-0.10ms");
  });

  it("H10: exactly 5 deltas shows all 5", () => {
    const deltas: PropDelta[] = [];
    for (let i = 0; i < 5; i++) {
      deltas.push({ propName: `p${i}`, baseValue: false, flipValue: true, mountDelta: i + 1, rerenderDelta: 0 });
    }
    const report = makeReport(deltas);
    const output = formatTable(report);
    for (let i = 0; i < 5; i++) {
      expect(output).toContain(`p${i}`);
    }
  });
});
