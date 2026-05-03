import { describe, it, expect } from "vitest";
import { formatTable, type Report, type PropDelta } from "../../src/report.js";

describe("PropDelta in Report", () => {
  function makeReport(propDeltas?: PropDelta[]): Report {
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
      propDeltas,
    };
  }

  it("Report type accepts propDeltas field", () => {
    const report = makeReport([
      { propName: "disabled", baseValue: false, flipValue: true, mountDelta: 0.5, rerenderDelta: 0.1 },
    ]);
    expect(report.propDeltas).toHaveLength(1);
    expect(report.propDeltas![0].mountDelta).toBe(0.5);
  });

  it("Report type accepts undefined propDeltas", () => {
    const report = makeReport(undefined);
    expect(report.propDeltas).toBeUndefined();
  });

  it("propDeltas sorted by |mountDelta| descending", () => {
    const deltas: PropDelta[] = [
      { propName: "a", baseValue: false, flipValue: true, mountDelta: 0.1, rerenderDelta: 0 },
      { propName: "b", baseValue: false, flipValue: true, mountDelta: -0.5, rerenderDelta: 0 },
      { propName: "c", baseValue: false, flipValue: true, mountDelta: 0.3, rerenderDelta: 0 },
    ];
    const sorted = [...deltas].sort((a, b) => Math.abs(b.mountDelta) - Math.abs(a.mountDelta));
    expect(sorted[0].propName).toBe("b");
    expect(sorted[1].propName).toBe("c");
    expect(sorted[2].propName).toBe("a");
  });

  it("formatTable includes Prop Deltas section", () => {
    const report = makeReport([
      { propName: "spotlight", baseValue: false, flipValue: true, mountDelta: 0.42, rerenderDelta: 0.18 },
      { propName: "variant", baseValue: "primary", flipValue: "ghost", mountDelta: 0.15, rerenderDelta: 0.02 },
    ]);
    const output = formatTable(report);
    expect(output).toContain("Prop Deltas");
    expect(output).toContain("spotlight");
    expect(output).toContain("false");
    expect(output).toContain("true");
    expect(output).toContain("+0.42ms");
  });

  it("formatTable shows top 5 deltas only", () => {
    const deltas: PropDelta[] = [];
    for (let i = 0; i < 8; i++) {
      deltas.push({ propName: `prop${i}`, baseValue: false, flipValue: true, mountDelta: i + 1, rerenderDelta: 0 });
    }
    const report = makeReport(deltas);
    const output = formatTable(report);
    expect(output).toContain("prop7");
    expect(output).not.toContain("prop0");
    expect(output).not.toContain("prop1");
    expect(output).not.toContain("prop2");
  });

  it("formatTable omits Prop Deltas section when propDeltas is empty", () => {
    const report = makeReport([]);
    const output = formatTable(report);
    expect(output).not.toContain("Prop Deltas");
  });

  it("formatTable omits Prop Deltas section when propDeltas is undefined", () => {
    const report = makeReport(undefined);
    const output = formatTable(report);
    expect(output).not.toContain("Prop Deltas");
  });
});
