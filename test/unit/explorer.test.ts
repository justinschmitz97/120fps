import { describe, it, expect } from "vitest";
import { fnv1aHash, createRng, restoreComboIndices } from "../../src/explorer.js";

describe("restoreComboIndices", () => {
  it("translates subset positions back into full combo indices", () => {
    const results = [
      { comboIndex: 0, label: "hottest" },
      { comboIndex: 1, label: "second" },
      { comboIndex: 2, label: "third" },
    ];
    expect(restoreComboIndices(results, [7, 2, 11])).toEqual([
      { comboIndex: 7, label: "hottest" },
      { comboIndex: 2, label: "second" },
      { comboIndex: 11, label: "third" },
    ]);
  });

  it("is identity when the subset is the whole set in order", () => {
    const results = [{ comboIndex: 0 }, { comboIndex: 1 }];
    expect(restoreComboIndices(results, [0, 1])).toEqual(results);
  });

  it("does not mutate the input results", () => {
    const results = [{ comboIndex: 0 }];
    restoreComboIndices(results, [5]);
    expect(results[0].comboIndex).toBe(0);
  });

  it("returns empty for empty results", () => {
    expect(restoreComboIndices([], [3, 4])).toEqual([]);
  });

  it("throws when a result has no corresponding source index", () => {
    expect(() => restoreComboIndices([{ comboIndex: 3 }], [0, 1])).toThrow(/sourceIndices/);
  });
});

describe("fnv1aHash", () => {
  it("returns consistent hash for same input", () => {
    expect(fnv1aHash("hello")).toBe(fnv1aHash("hello"));
  });

  it("returns different hashes for different inputs", () => {
    expect(fnv1aHash("hello")).not.toBe(fnv1aHash("world"));
  });

  it("returns hex string", () => {
    const h = fnv1aHash("test");
    expect(typeof h).toBe("string");
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  it("handles empty string", () => {
    const h = fnv1aHash("");
    expect(typeof h).toBe("string");
    expect(h.length).toBeGreaterThan(0);
  });

  it("differentiates similar DOM strings", () => {
    expect(fnv1aHash("<div>1</div>")).not.toBe(fnv1aHash("<div>2</div>"));
    expect(fnv1aHash("<span>A</span>")).not.toBe(fnv1aHash("<span>B</span>"));
  });

  it("produces 8-char hex string", () => {
    expect(fnv1aHash("test")).toHaveLength(8);
  });
});

describe("createRng", () => {
  it("produces deterministic sequence for same seed", () => {
    const rng1 = createRng(42);
    const rng2 = createRng(42);
    const seq1 = Array.from({ length: 20 }, () => rng1());
    const seq2 = Array.from({ length: 20 }, () => rng2());
    expect(seq1).toEqual(seq2);
  });

  it("produces different sequences for different seeds", () => {
    const rng1 = createRng(42);
    const rng2 = createRng(99);
    const seq1 = Array.from({ length: 5 }, () => rng1());
    const seq2 = Array.from({ length: 5 }, () => rng2());
    expect(seq1).not.toEqual(seq2);
  });

  it("produces values in [0, 1)", () => {
    const rng = createRng(42);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("seed 0 does not produce all zeros", () => {
    const rng = createRng(0);
    const vals = Array.from({ length: 5 }, () => rng());
    expect(new Set(vals).size).toBeGreaterThan(1);
  });
});
