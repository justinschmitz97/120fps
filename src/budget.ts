import fs from "node:fs";
import path from "node:path";
import { TIER_BUDGETS, type ComponentTier, type TierBudget } from "./report.js";

export interface ComponentBudget {
  tier?: ComponentTier;
  mount?: number;
  rerender?: number;
  interaction?: number;
  unmount?: number;
}

export interface BudgetConfig {
  defaults?: ComponentBudget;
  components?: Record<string, ComponentBudget>;
  tolerance?: {
    mount?: number;
    rerender?: number;
    interaction?: number;
    unmount?: number;
  };
}

export interface BaselineEntry {
  mount: number;
  rerender: number;
  unmount: number;
  domNodeCount: number;
  interactions: Record<string, number>;
  tier: ComponentTier;
}

export interface Baseline {
  version: 1;
  timestamp: string;
  entries: Record<string, BaselineEntry>;
}

export interface ResolvedTolerance {
  mount: number;
  rerender: number;
  interaction: number;
  unmount: number;
}

export interface BaselineComparison {
  hasBaseline: boolean;
  regressions: Regression[];
  improvements: Improvement[];
}

export interface Regression {
  metric: string;
  baseline: number;
  current: number;
  deltaPercent: number;
  tolerance: number;
}

export interface Improvement {
  metric: string;
  baseline: number;
  current: number;
  deltaPercent: number;
}

const DEFAULT_TOLERANCE: ResolvedTolerance = {
  mount: 10,
  rerender: 15,
  interaction: 15,
  unmount: 20,
};

export function loadBudgetConfig(projectRoot: string): BudgetConfig | null {
  const configPath = path.join(projectRoot, "120fps.config.json");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as BudgetConfig;
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw new Error(`Failed to load 120fps.config.json: ${err.message}`);
  }
}

export function loadBaseline(baselinePath: string): Baseline | null {
  try {
    const raw = fs.readFileSync(baselinePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1) return null;
    return parsed as Baseline;
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export function saveBaseline(
  baselinePath: string,
  entry: BaselineEntry,
  componentPath: string,
): void {
  let existing: Baseline | null = null;
  try {
    const raw = fs.readFileSync(baselinePath, "utf-8");
    existing = JSON.parse(raw) as Baseline;
  } catch {
    // file doesn't exist or is invalid — start fresh
  }

  const baseline: Baseline = {
    version: 1,
    timestamp: new Date().toISOString(),
    entries: existing?.entries ?? {},
  };
  baseline.entries[componentPath] = entry;

  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), "utf-8");
}

export function resolveTolerances(config: BudgetConfig | null): ResolvedTolerance {
  return {
    mount: config?.tolerance?.mount ?? DEFAULT_TOLERANCE.mount,
    rerender: config?.tolerance?.rerender ?? DEFAULT_TOLERANCE.rerender,
    interaction: config?.tolerance?.interaction ?? DEFAULT_TOLERANCE.interaction,
    unmount: config?.tolerance?.unmount ?? DEFAULT_TOLERANCE.unmount,
  };
}

export function resolveComponentBudget(
  config: BudgetConfig | null,
  componentPath: string,
  autoTier: ComponentTier,
): TierBudget {
  const perComponent = config?.components?.[componentPath];
  const defaults = config?.defaults;

  const tier = perComponent?.tier ?? defaults?.tier ?? autoTier;
  const tierBudget = TIER_BUDGETS[tier];

  return {
    mountMs: perComponent?.mount ?? defaults?.mount ?? tierBudget.mountMs,
    rerenderMs: perComponent?.rerender ?? defaults?.rerender ?? tierBudget.rerenderMs,
    interactionMs: perComponent?.interaction ?? defaults?.interaction ?? tierBudget.interactionMs,
  };
}

export function compareBaseline(
  entry: BaselineEntry,
  current: { mount: number; rerender: number; unmount: number; interactions: Record<string, number> },
  tolerance: ResolvedTolerance,
  unstableMetrics?: Set<string>,
): BaselineComparison {
  const regressions: Regression[] = [];
  const improvements: Improvement[] = [];

  const metrics: Array<{ name: string; baseline: number; current: number; tol: number }> = [
    { name: "mount", baseline: entry.mount, current: current.mount, tol: tolerance.mount },
    { name: "rerender", baseline: entry.rerender, current: current.rerender, tol: tolerance.rerender },
    { name: "unmount", baseline: entry.unmount, current: current.unmount, tol: tolerance.unmount },
  ];

  for (const [label, baselineMs] of Object.entries(entry.interactions)) {
    const currentMs = current.interactions[label];
    if (currentMs !== undefined) {
      metrics.push({ name: `interaction:${label}`, baseline: baselineMs, current: currentMs, tol: tolerance.interaction });
    }
  }

  for (const m of metrics) {
    if (m.baseline <= 0) continue;
    if (unstableMetrics?.has(m.name)) continue;

    const deltaPercent = ((m.current - m.baseline) / m.baseline) * 100;

    if (m.current > m.baseline * (1 + m.tol / 100)) {
      regressions.push({
        metric: m.name,
        baseline: m.baseline,
        current: m.current,
        deltaPercent,
        tolerance: m.tol,
      });
    } else if (deltaPercent < -5) {
      improvements.push({
        metric: m.name,
        baseline: m.baseline,
        current: m.current,
        deltaPercent,
      });
    }
  }

  return { hasBaseline: true, regressions, improvements };
}
