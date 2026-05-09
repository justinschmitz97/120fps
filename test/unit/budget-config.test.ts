import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadBudgetConfig,
  resolveComponentBudget,
  resolveTolerances,
  type BudgetConfig,
} from "../../src/budget.js";
import { TIER_BUDGETS } from "../../src/report.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-budget-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadBudgetConfig", () => {
  it("returns null when file does not exist", () => {
    expect(loadBudgetConfig(tmpDir)).toBeNull();
  });

  it("parses valid config", () => {
    const config: BudgetConfig = {
      defaults: { mount: 20 },
      tolerance: { mount: 15 },
    };
    fs.writeFileSync(path.join(tmpDir, "120fps.config.json"), JSON.stringify(config));
    const loaded = loadBudgetConfig(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.defaults!.mount).toBe(20);
    expect(loaded!.tolerance!.mount).toBe(15);
  });

  it("parses config with per-component budgets", () => {
    const config: BudgetConfig = {
      components: {
        "./Button.tsx": { mount: 10, tier: "T1" },
        "./Accordion.tsx": { mount: 30, tier: "T3" },
      },
    };
    fs.writeFileSync(path.join(tmpDir, "120fps.config.json"), JSON.stringify(config));
    const loaded = loadBudgetConfig(tmpDir);
    expect(loaded!.components!["./Button.tsx"].mount).toBe(10);
    expect(loaded!.components!["./Accordion.tsx"].tier).toBe("T3");
  });

  it("throws on invalid JSON", () => {
    fs.writeFileSync(path.join(tmpDir, "120fps.config.json"), "not json{{{");
    expect(() => loadBudgetConfig(tmpDir)).toThrow();
  });
});

describe("resolveComponentBudget", () => {
  it("returns tier budget when config is null", () => {
    const budget = resolveComponentBudget(null, "./Button.tsx", "T1");
    expect(budget.mountMs).toBe(TIER_BUDGETS.T1.mountMs);
    expect(budget.rerenderMs).toBe(TIER_BUDGETS.T1.rerenderMs);
    expect(budget.interactionMs).toBe(TIER_BUDGETS.T1.interactionMs);
  });

  it("defaults config overrides tier budget", () => {
    const config: BudgetConfig = { defaults: { mount: 25 } };
    const budget = resolveComponentBudget(config, "./Button.tsx", "T1");
    expect(budget.mountMs).toBe(25);
    expect(budget.rerenderMs).toBe(TIER_BUDGETS.T1.rerenderMs);
  });

  it("per-component config overrides defaults", () => {
    const config: BudgetConfig = {
      defaults: { mount: 25 },
      components: { "./Button.tsx": { mount: 12 } },
    };
    const budget = resolveComponentBudget(config, "./Button.tsx", "T1");
    expect(budget.mountMs).toBe(12);
  });

  it("per-component tier overrides auto tier", () => {
    const config: BudgetConfig = {
      components: { "./Button.tsx": { tier: "T4" } },
    };
    const budget = resolveComponentBudget(config, "./Button.tsx", "T1");
    expect(budget.mountMs).toBe(TIER_BUDGETS.T4.mountMs);
  });

  it("defaults tier overrides auto tier when no per-component", () => {
    const config: BudgetConfig = { defaults: { tier: "T3" } };
    const budget = resolveComponentBudget(config, "./Other.tsx", "T1");
    expect(budget.mountMs).toBe(TIER_BUDGETS.T3.mountMs);
  });

  it("unmatched component falls back to defaults then tier", () => {
    const config: BudgetConfig = {
      components: { "./Button.tsx": { mount: 12 } },
    };
    const budget = resolveComponentBudget(config, "./Other.tsx", "T2");
    expect(budget.mountMs).toBe(TIER_BUDGETS.T2.mountMs);
  });
});

describe("resolveTolerances", () => {
  it("returns defaults when config is null", () => {
    const tol = resolveTolerances(null);
    expect(tol.mount).toBe(10);
    expect(tol.rerender).toBe(15);
    expect(tol.interaction).toBe(15);
    expect(tol.unmount).toBe(20);
  });

  it("overrides specified tolerances", () => {
    const config: BudgetConfig = { tolerance: { mount: 5, rerender: 8 } };
    const tol = resolveTolerances(config);
    expect(tol.mount).toBe(5);
    expect(tol.rerender).toBe(8);
    expect(tol.interaction).toBe(15);
    expect(tol.unmount).toBe(20);
  });
});
