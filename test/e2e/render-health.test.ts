import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyze, type AnalyzeOptions } from "../../src/analyze.js";
import { formatTable } from "../../src/report.js";

function tmpJson(): string {
  return path.join(os.tmpdir(), `120fps-m59-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

const FAST: AnalyzeOptions = {
  samples: 2,
  warmupRuns: 1,
  scalePoints: [1],
  skipDeltas: true,
  skipAutoScale: true,
  skipAttribution: true,
  skipReactAnalysis: true,
  noWrap: true,
  exploreBudgetMs: 4000,
};

async function run(component: string, extra: AnalyzeOptions = {}) {
  const jsonPath = tmpJson();
  try {
    return await analyze(component, { ...FAST, ...extra, jsonPath });
  } finally {
    if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
  }
}

describe("a component that throws on mount", () => {
  it("fails the run, names the throw, and marks the combo render-errored", async () => {
    const report = await run("./fixtures/m59-throws-on-mount.tsx");

    expect(report.combos.length).toBeGreaterThan(0);
    for (const combo of report.combos) {
      expect(combo.domNodeCount).toBe(0);
      expect(combo.renderHealth).toBe("error");
      expect(combo.verdict).toBe("fail");
      expect(combo.pageErrors?.join("\n")).toContain("ThemedBadge must be rendered inside a ThemeProvider");
    }
    expect(report.pass).toBe(false);

    const out = formatTable(report);
    expect(out).toContain("[render error]");
    expect(out).toContain("ThemedBadge must be rendered inside a ThemeProvider");
    expect(out).toContain("Result: FAIL");
    expect(out).not.toContain("Consider creating");
  }, 180_000);
});

describe("a component that renders null legitimately", () => {
  it("annotates the empty render and still passes", async () => {
    const report = await run("./fixtures/m59-renders-nothing.tsx");

    // The synthetic scale probe wraps its copies, so it contributes a node even
    // when the component itself renders nothing; the real combos render zero.
    const empty = report.combos.filter((c) => c.domNodeCount === 0);
    expect(empty.length).toBeGreaterThan(0);
    for (const combo of report.combos) {
      expect(combo.pageErrors).toBeUndefined();
      expect(combo.verdict).not.toBe("fail");
      expect(combo.renderHealth).toBe(combo.domNodeCount === 0 ? "empty" : undefined);
    }
    expect(report.pass).toBe(true);
    expect(formatTable(report)).toMatch(/rendered no DOM nodes/i);
  }, 180_000);
});

describe("a healthy component", () => {
  it("carries no render-health annotation and no page errors", async () => {
    const report = await run("./fixtures/button.tsx");

    expect(report.combos.length).toBeGreaterThan(0);
    const rendered = report.combos.filter((c) => c.domNodeCount > 0);
    expect(rendered.length).toBeGreaterThan(0);
    for (const combo of rendered) {
      expect(combo.renderHealth).toBeUndefined();
      expect(combo.pageErrors).toBeUndefined();
    }

    const out = formatTable(report);
    expect(out).not.toContain("[render error]");
    expect(out).not.toContain("Page errors");
  }, 180_000);
});
