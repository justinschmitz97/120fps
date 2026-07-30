import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadBaseline,
  compareBaseline,
  resolveTolerances,
  type BaselineEntry,
} from "../../src/budget.js";

let tmpDir: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-m24-baseline-"));
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function stderrText(): string {
  return stderrSpy.mock.calls.map((c) => String(c[0])).join("");
}

function makeEntry(overrides: Partial<BaselineEntry> = {}): BaselineEntry {
  return {
    mount: 1.0,
    rerender: 0.5,
    unmount: 0.1,
    domNodeCount: 10,
    interactions: {},
    tier: "T1",
    ...overrides,
  };
}

const TOL = resolveTolerances(null);

describe("D6: loadBaseline version warning", () => {
  it("warns on stderr and returns null for version 2", () => {
    const p = path.join(tmpDir, "120fps-baseline.json");
    fs.writeFileSync(p, JSON.stringify({ version: 2, timestamp: "x", entries: {} }));
    expect(loadBaseline(p)).toBeNull();
    expect(stderrText()).toMatch(/unsupported baseline version, ignoring/);
  });

  it("warns and returns null when version field is missing", () => {
    const p = path.join(tmpDir, "120fps-baseline.json");
    fs.writeFileSync(p, JSON.stringify({ timestamp: "x", entries: {} }));
    expect(loadBaseline(p)).toBeNull();
    expect(stderrText()).toMatch(/unsupported baseline version, ignoring/);
  });

  it("warns and returns null when version is the string \"1\"", () => {
    const p = path.join(tmpDir, "120fps-baseline.json");
    fs.writeFileSync(p, JSON.stringify({ version: "1", timestamp: "x", entries: {} }));
    expect(loadBaseline(p)).toBeNull();
    expect(stderrText()).toMatch(/unsupported baseline version, ignoring/);
  });

  it("does not warn for version 1", () => {
    const p = path.join(tmpDir, "120fps-baseline.json");
    fs.writeFileSync(p, JSON.stringify({ version: 1, timestamp: "x", entries: {} }));
    expect(loadBaseline(p)).not.toBeNull();
    expect(stderrText()).toBe("");
  });

  it("does not warn when file does not exist", () => {
    expect(loadBaseline(path.join(tmpDir, "nope.json"))).toBeNull();
    expect(stderrText()).toBe("");
  });

  it("still throws on malformed JSON (unchanged behavior)", () => {
    const p = path.join(tmpDir, "120fps-baseline.json");
    fs.writeFileSync(p, "{ not json");
    expect(() => loadBaseline(p)).toThrow();
    expect(stderrText()).toBe("");
  });
});

describe("D6: compareBaseline missingInteractions", () => {
  it("reports baseline interactions absent from the current run", () => {
    const entry = makeEntry({ interactions: { "click button": 100, "hover card": 50 } });
    const current = { mount: 1.0, rerender: 0.5, unmount: 0.1, interactions: { "click button": 100 } };
    const result = compareBaseline(entry, current, TOL);
    expect(result.missingInteractions).toEqual(["hover card"]);
  });

  it("is an empty array when all baseline interactions are present", () => {
    const entry = makeEntry({ interactions: { "click button": 100 } });
    const current = { mount: 1.0, rerender: 0.5, unmount: 0.1, interactions: { "click button": 100 } };
    const result = compareBaseline(entry, current, TOL);
    expect(result.missingInteractions).toEqual([]);
  });

  it("is an empty array when baseline has no interactions", () => {
    const entry = makeEntry({ interactions: {} });
    const current = { mount: 1.0, rerender: 0.5, unmount: 0.1, interactions: { "new one": 10 } };
    const result = compareBaseline(entry, current, TOL);
    expect(result.missingInteractions).toEqual([]);
  });

  it("missing interactions never produce regressions", () => {
    const entry = makeEntry({ interactions: { gone: 100 } });
    const current = { mount: 1.0, rerender: 0.5, unmount: 0.1, interactions: {} };
    const result = compareBaseline(entry, current, TOL);
    expect(result.missingInteractions).toEqual(["gone"]);
    expect(result.regressions).toHaveLength(0);
  });
});
