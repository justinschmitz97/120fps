import { analyze, type AnalyzeOptions } from "../../src/analyze.js";
import type { Report } from "../../src/report.js";

// A full analyze pass costs 15-120s of throttled browser work, and e2e files
// routinely run the same one several times to assert different fields of the
// same report. vitest gives each file its own worker, so memoising per process
// collapses exactly those duplicates and nothing else.
//
// The returned report is shared, not copied: assertions must read it, not
// mutate it.
const inFlight = new Map<string, Promise<Report>>();

export function sharedAnalyze(
  componentPath: string,
  options: AnalyzeOptions = {},
): Promise<Report> {
  // Runs whose side effect is the assertion must actually happen every time.
  if (options.jsonPath || options.saveBaseline || options.check || options.initFixture) {
    return analyze(componentPath, options);
  }

  const key = `${componentPath}::${JSON.stringify(options)}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const run = analyze(componentPath, options);
  inFlight.set(key, run);
  return run;
}
