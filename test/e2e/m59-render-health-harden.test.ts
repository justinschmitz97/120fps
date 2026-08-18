import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyze, type AnalyzeOptions } from "../../src/analyze.js";
import { formatTable } from "../../src/report.js";

function tmpJson(): string {
  return path.join(os.tmpdir(), `120fps-m59h-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
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

const allErrors = (report: { combos: { pageErrors?: string[] }[] }) =>
  report.combos.flatMap((c) => c.pageErrors ?? []).join("\n");

// H1 — a throw after paint. React unwinds the whole root when an effect throws
// with no boundary above it, so the measured scene really is empty and the gate
// is the right answer.
describe("H1: throws from an effect after paint", () => {
  it("gates the combo, because React tore the tree down", async () => {
    const report = await run("./fixtures/m59-throws-in-effect.tsx");
    expect(report.combos.every((c) => c.domNodeCount === 0)).toBe(true);
    expect(report.combos.some((c) => c.renderHealth === "error")).toBe(true);
    expect(allErrors(report)).toContain("effect blew up after paint");
    expect(report.pass).toBe(false);
  }, 180_000);
});

// H2 — a throw in the effect cleanup, i.e. during unmount.
describe("H2: throws during unmount", () => {
  it("reports the cleanup throw without gating the combo", async () => {
    const report = await run("./fixtures/m59-throws-on-unmount.tsx");
    expect(report.combos.some((c) => c.domNodeCount > 0)).toBe(true);
    expect(allErrors(report)).toContain("cleanup blew up");
    for (const combo of report.combos) expect(combo.renderHealth).not.toBe("error");
  }, 180_000);
});

// H3 — a throw only the rerender pass can trigger.
describe("H3: throws on update, never on mount", () => {
  it("mounts cleanly and surfaces the update throw on the combo", async () => {
    const report = await run("./fixtures/m59-throws-on-update.tsx");
    expect(report.combos.some((c) => c.domNodeCount > 0)).toBe(true);
    expect(allErrors(report)).toContain("update render blew up");
  }, 180_000);
});

// H4 — React's own console.error channel must never gate.
describe("H4: console.error on a component that renders null", () => {
  it("annotates the empty render and passes", async () => {
    const report = await run("./fixtures/m59-console-noise.tsx");
    for (const combo of report.combos) {
      expect(combo.renderHealth).not.toBe("error");
      expect(combo.verdict).not.toBe("fail");
    }
    expect(report.pass).toBe(true);
    expect(allErrors(report)).toContain("unique \"key\" prop");
  }, 180_000);
});

// H5 — more distinct messages than the 20-entry cap, plus a real throw.
describe("H5: error cap overflow", () => {
  it("keeps 20 messages, says how many it dropped, and still gates", async () => {
    const report = await run("./fixtures/m59-many-errors.tsx");
    const gated = report.combos.filter((c) => c.renderHealth === "error");
    expect(gated.length).toBeGreaterThan(0);
    for (const combo of gated) {
      expect(combo.pageErrors!.length).toBeLessThanOrEqual(21);
      expect(combo.pageErrors!.some((m) => /\(\+\d+ more dropped\)/.test(m))).toBe(true);
    }
    expect(report.pass).toBe(false);
  }, 180_000);
});

// H6 — everything the component renders lives in a portal, and it throws.
describe("H6: a portal child throws", () => {
  it("gates the combo the same way an inline throw does", async () => {
    const report = await run("./fixtures/m59-portal-throws.tsx");
    expect(report.combos.every((c) => c.domNodeCount === 0)).toBe(true);
    expect(report.combos.some((c) => c.renderHealth === "error")).toBe(true);
    expect(allErrors(report)).toContain("portal content blew up");
    expect(report.pass).toBe(false);
  }, 180_000);
});

// H7 — Vue mounts synchronously, so a setup throw propagates out of the mount
// call instead of only reaching the page. The run aborts rather than reporting,
// which is not a silent pass; the phase context is what makes it diagnosable.
describe("H7: a Vue SFC that throws during setup", () => {
  it("aborts the run naming the phase, the combo and the component", async () => {
    await expect(
      run("./fixtures/vue-project/Throws.vue", { framework: "vue" }),
    ).rejects.toThrow(
      /mount phase failed on combo 0 of Throws\.vue:.*vue fixture blew up during setup/s,
    );
  }, 180_000);
});

// H8 — the same question for a throw from the render function.
describe("H8: a Vue SFC that throws during render", () => {
  it("does not report a passing run", async () => {
    let report: Awaited<ReturnType<typeof run>> | undefined;
    let failure: Error | undefined;
    try {
      report = await run("./fixtures/vue-project/RenderThrows.vue", { framework: "vue" });
    } catch (err) {
      failure = err as Error;
    }
    if (failure) {
      expect(failure.message).toContain("mount phase failed");
      expect(failure.message).toContain("vue fixture blew up during render");
      return;
    }
    expect(report!.pass).toBe(false);
    expect(report!.combos.some((c) => c.renderHealth === "error")).toBe(true);
    expect(allErrors(report!)).toContain("vue fixture blew up during render");
    expect(formatTable(report!)).toContain("[render error]");
  }, 180_000);
});
