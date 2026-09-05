import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { watchdogAbortOutput, RUN_WATCHDOG_ABORT_ERROR } from "../../src/cli/index.js";
import { measuredOnly } from "../../src/browser/index.js";

// midday-NEW1: the abort's roots/total got lost behind a later, unrelated teardown crash.

const cliSrc = fs.readFileSync(path.resolve("src", "cli/main.ts"), "utf-8");
const COMPONENT = path.resolve("fixtures", "simple.tsx");

describe("what an aborted run prints on its way out", () => {
  it("leads with the abort sentence on stderr", () => {
    const out = watchdogAbortOutput(COMPONENT, 20 * 60_000, "stalled", 1_269_000, false);
    expect(out.stderr).toBe(RUN_WATCHDOG_ABORT_ERROR(COMPONENT, 20 * 60_000, "stalled"));
    expect(out.stderr).toContain("made no progress for 20 minutes");
  });

  it("still names the roots it resolved", () => {
    const out = watchdogAbortOutput(COMPONENT, 20 * 60_000, "stalled", 1_269_000, false);
    expect(out.stdout).toMatch(/^Roots?: /);
  });

  it("still says where the minutes went", () => {
    const out = watchdogAbortOutput(COMPONENT, 20 * 60_000, "stalled", 1_269_000, false);
    expect(out.stdout).toContain("Total: 21m 9s");
    expect(out.stdout.endsWith("\n")).toBe(true);
  });

  it("prints the roots line before the total, the order a finished run uses", () => {
    const out = watchdogAbortOutput(COMPONENT, 20 * 60_000, "stalled", 1_269_000, false);
    expect(out.stdout.indexOf("Root")).toBeLessThan(out.stdout.indexOf("Total: "));
  });

  it("writes nothing to stdout under --ci, which owns stdout for JSON", () => {
    const out = watchdogAbortOutput(COMPONENT, 20 * 60_000, "stalled", 1_269_000, true);
    expect(out.stdout).toBe("");
    expect(out.stderr).not.toBe("");
  });

  it("still prints the abort sentence and the total when the roots cannot be resolved", () => {
    const missing = path.resolve("no-such-directory-116", "Button.tsx");
    const out = watchdogAbortOutput(missing, 20 * 60_000, "stalled", 1_269_000, false);
    expect(out.stderr).toBe(RUN_WATCHDOG_ABORT_ERROR(missing, 20 * 60_000, "stalled"));
    expect(out.stdout).toContain("Total: 21m 9s");
  });

  it("carries the total-budget wording through unchanged", () => {
    const out = watchdogAbortOutput(COMPONENT, 20 * 60_000, "total", 1_000, false);
    expect(out.stderr).toContain("exceeded its total budget");
  });
});

describe("the abort owns the run's one error and its exit", () => {
  it("the watchdog prints through watchdogAbortOutput and then aborts", () => {
    const callback = cliSrc.slice(
      cliSrc.indexOf("const runWatchdog = createRunWatchdog(budgetMs"),
      cliSrc.indexOf("const report = await runOne("),
    );
    expect(callback).toContain("aborted = true;");
    expect(callback).toContain("watchdogAbortOutput(componentPath, budgetMs, bound, Date.now() - started, args.ci)");
    expect(callback.indexOf("out.stderr")).toBeLessThan(callback.indexOf("void abortRun(2,"));
  });

  it("the component's own catch prints no second error once the abort fired", () => {
    const catchBlock = cliSrc.slice(
      cliSrc.indexOf("} catch (err: unknown) {\n      // The abort already printed"),
      cliSrc.indexOf("    } finally {\n      runWatchdog.clear();"),
    );
    expect(catchBlock).toContain("if (aborted) return;");
    expect(catchBlock.indexOf("if (aborted) return;")).toBeLessThan(
      catchBlock.indexOf("formatCliError(err, process.env.DEBUG)"),
    );
  });
});

// midday-NEW1 root cause: reading .props of an unset slot crashes; measuredOnly must drop holes.

describe("a measurement pass that omitted combos", () => {
  it("hands its iterating consumers only the combos that measured", () => {
    const results: Array<{ comboIndex: number; props: Record<string, unknown> }> = new Array(4);
    results[0] = { comboIndex: 0, props: { a: 1 } };
    results[3] = { comboIndex: 3, props: { a: 2 } };
    expect(measuredOnly(results).map((r) => r.comboIndex)).toEqual([0, 3]);
  });

  it("reading the raw array with for..of is what produced the crash", () => {
    const results: Array<{ props: Record<string, unknown> }> = new Array(3);
    results[0] = { props: {} };
    expect(() => {
      for (const r of results) void r.props;
    }).toThrow("Cannot read properties of undefined (reading 'props')");
    expect(() => {
      for (const r of measuredOnly(results)) void r.props;
    }).not.toThrow();
  });

  it("keeps the holes in the array itself, which curve mode indexes by position", () => {
    const results: Array<{ comboIndex: number } | undefined> = new Array(3);
    results[2] = { comboIndex: 2 };
    expect(measuredOnly(results)).toHaveLength(1);
    expect(results).toHaveLength(3);
  });

  it("every delta-pass consumer of a result array asks for the measured entries", () => {
    // Every pass lives in the pipeline stage; the guard is about all of them.
    const read = (dir: string): string =>
      fs
        .readdirSync(dir, { withFileTypes: true })
        .map((e) =>
          e.isDirectory() ? read(path.join(dir, e.name)) : fs.readFileSync(path.join(dir, e.name), "utf-8"),
        )
        .join("\n");
    const analyzeSrc = read(path.resolve("src", "pipeline"));
    for (const raw of [
      "for (const m of mounts)",
      "for (const r of rerenders)",
      "for (const m of extraMounts)",
      "for (const r of extraRerenders)",
      "for (const m of matrixMounts)",
    ]) {
      expect(analyzeSrc).not.toContain(raw + " ");
    }
    expect(analyzeSrc).toContain("for (const m of measuredOnly(mounts)) {");
    expect(analyzeSrc).toContain("for (const r of measuredOnly(rerenders)) {");
  });
});
