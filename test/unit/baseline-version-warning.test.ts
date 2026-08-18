import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadBaseline } from "../../src/budget.js";

let tmpDir: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-baseline-warn-"));
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function stderrText(): string {
  return stderrSpy.mock.calls.map((c) => String(c[0])).join("");
}

describe("loadBaseline version warning", () => {
  it("warns on stderr and returns null for an unsupported version", () => {
    const p = path.join(tmpDir, "120fps-baseline.json");
    fs.writeFileSync(p, JSON.stringify({ version: 99, timestamp: "x", entries: {} }));
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
