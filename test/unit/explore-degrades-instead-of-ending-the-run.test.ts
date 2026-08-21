import { describe, it, expect } from "vitest";
import { EXPLORE_STALLED_WARNING } from "../../src/explorer.js";
import { executeStressPattern, resolveStressPattern } from "../../src/stress-patterns.js";
import type { Page } from "playwright-core";

// calcom-F3: a Radix Popover trigger drew `open-close-10` (20 clicks, each
// with a 3 s page.click timeout). Radix's `modal` variant sets
// `body { pointer-events: none }` while the portal is open, so 19 of the 20
// clicks time out — 57 s inside a 60 s tracing window, on a phase whose
// --explore-budget had already been spent. The run ended at exit 2 with no
// report, and the printed remedy (--no-attribution) was measured ineffective.

// A page that never resolves a click within the caller's own budget: the
// smallest reproduction of a pointer-events-blocked trigger.
function blockedPage(clickMs: number): Page {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    click: async () => { await sleep(clickMs); throw new Error("Timeout 3000ms exceeded."); },
    keyboard: { press: async () => {}, type: async () => {} },
    hover: async () => {},
    focus: async () => {},
    fill: async () => {},
    selectOption: async () => {},
    mouse: { move: async () => {}, wheel: async () => {}, down: async () => {}, up: async () => {} },
    evaluate: async () => null,
  } as unknown as Page;
}

describe("a stress pattern cannot outlive the budget that bounds it", () => {
  it("stops at the remaining wall clock and reports how many steps ran", async () => {
    const pattern = { name: "open-close-10", steps: Array.from({ length: 20 }, () => ({ action: "click" as const, selector: "button" })) };
    const run = await executeStressPattern(blockedPage(30), pattern, 100);
    expect(run.budgetExhausted).toBe(true);
    expect(run.stepsRun).toBeGreaterThan(0);
    expect(run.stepsRun).toBeLessThan(run.stepsPlanned);
  });

  it("runs every step when the budget is not reached", async () => {
    const pattern = { name: "single-shot", steps: [{ action: "click" as const, selector: "button" }] };
    const run = await executeStressPattern(blockedPage(0), pattern, 60_000);
    expect(run).toEqual({ stepsRun: 1, stepsPlanned: 1, budgetExhausted: false });
  });

  it("runs unbounded when no budget is supplied, as every existing caller did", async () => {
    const pattern = { name: "single-shot", steps: [{ action: "click" as const, selector: "button" }] };
    const run = await executeStressPattern(blockedPage(0), pattern);
    expect(run.budgetExhausted).toBe(false);
    expect(run.stepsRun).toBe(1);
  });

  it("still resolves open-close-10 for the trigger shape that produced the stall", () => {
    const pattern = resolveStressPattern(
      { selector: "button[aria-haspopup='dialog']", type: "click", label: "open" },
      [],
    );
    expect(pattern.steps.length).toBeGreaterThan(1);
  });
});

describe("a stalled explore keeps what it measured and lets the report print", () => {
  it("names the combo, the interactions kept, and that the report still prints", () => {
    const warning = EXPLORE_STALLED_WARNING(0, 3);
    expect(warning).toContain("combo 0");
    expect(warning).toContain("explore skipped (tracing stalled)");
    expect(warning).toContain("3 interactions");
    expect(warning).toContain("report still prints");
  });

  it("does not pluralize a single kept interaction", () => {
    expect(EXPLORE_STALLED_WARNING(2, 1)).toContain("1 interaction measured");
  });
});
