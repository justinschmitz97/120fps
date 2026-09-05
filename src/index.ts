export { analyze, buildReport, type AnalyzeOptions, type BuildReportInput } from "./pipeline/index.js";

export type * from "./report/types.js";
export {
  DEFAULT_THRESHOLDS,
  TIER_BUDGETS,
  formatMarkdown,
  formatJUnit,
  loadBudgetConfig,
  validateBudgetConfig,
  hintsForReport,
  formatHints,
  HINTS,
  type BudgetConfig,
  type BaselineMetrics,
  type BaselineEntry,
  type HintId,
} from "./report/index.js";

export { parseArgs, type CliArgs } from "./cli/index.js";

export type { PropSchema, PropCombination } from "./props/index.js";
