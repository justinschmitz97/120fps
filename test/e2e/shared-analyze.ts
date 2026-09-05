import { analyze, type AnalyzeOptions } from "../../src/pipeline/index.js";
import type { Report } from "../../src/report/index.js";

// Each file gets its own vitest worker; memoizing per process collapses repeated ~15-120s passes.
const inFlight = new Map<string, Promise<Report>>();

// The returned report is shared: treat it as read-only.
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
