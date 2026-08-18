import { describe, it, expect } from "vitest";
import path from "node:path";
import { analyze, type AnalyzeOptions } from "../../src/analyze.js";

const FAST: AnalyzeOptions = {
  samples: 2,
  warmupRuns: 1,
  skipDeltas: true,
  skipAutoScale: true,
  skipAttribution: true,
  skipAutoCompose: true,
  skipReactAnalysis: true,
};

const FIXTURE = (name: string) => path.resolve("fixtures/m42-server", name);

describe("preflight gates the run", () => {
  it("fails fast on a server-only graph, before any harness boots", async () => {
    const started = Date.now();
    await expect(
      analyze(FIXTURE("reaches-server-only.tsx"), {
        ...FAST,
        jsonPath: "test-results/m42-server-only.json",
      }),
    ).rejects.toThrow(/server-only/);
    // A boot-and-timeout failure costs tens of seconds; a source walk costs one.
    expect(Date.now() - started).toBeLessThan(20000);
  }, 120000);

  it("fails on an async server component", async () => {
    await expect(
      analyze(FIXTURE("async-component.tsx"), {
        ...FAST,
        jsonPath: "test-results/m42-async.json",
      }),
    ).rejects.toThrow(/async function component/);
  }, 120000);

  it("--no-preflight runs anyway and discloses the bypass", async () => {
    // The run still fails downstream: the point is that preflight let it try.
    const outcome = await analyze(FIXTURE("reaches-server-only.tsx"), {
      ...FAST,
      noPreflight: true,
      jsonPath: "test-results/m42-bypass.json",
    }).then(
      (report) => ({ ok: true as const, report }),
      (err: Error) => ({ ok: false as const, err }),
    );
    if (outcome.ok) {
      expect((outcome.report.warnings ?? []).some((w) => w.includes("--no-preflight"))).toBe(true);
    } else {
      expect(outcome.err.message).not.toMatch(/Cannot measure this component/);
    }
  }, 300000);

  it("measures a clean component and warns about a Node builtin", async () => {
    const report = await analyze(FIXTURE("reaches-node-builtin.tsx"), {
      ...FAST,
      noPreflight: false,
      jsonPath: "test-results/m42-builtin.json",
    }).catch((err: Error) => err);
    // Vite may or may not boot a builtin-importing module; either way the
    // preflight must not have been the thing that stopped it.
    if (report instanceof Error) {
      expect(report.message).not.toMatch(/Cannot measure this component/);
    } else {
      expect((report.warnings ?? []).some((w) => w.includes("node:fs"))).toBe(true);
    }
  }, 300000);

  it("lets an ordinary component through untouched", async () => {
    const report = await analyze(FIXTURE("clean.tsx"), {
      ...FAST,
      jsonPath: "test-results/m42-clean.json",
    });
    expect(report.combos.length).toBeGreaterThan(0);
    expect((report.warnings ?? []).some((w) => w.includes("--no-preflight"))).toBe(false);
  }, 300000);
});
