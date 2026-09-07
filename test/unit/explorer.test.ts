import { describe, it, expect } from "vitest";
import { fnv1aHash, createRng, restoreComboIndices, createEscapeWatch } from "../../src/analysis/index.js";

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

describe("a click that leaves the harness page is caught and undone", () => {
  function fakePage(harnessAlive: () => boolean) {
    const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    return {
      on(event: string, handler: (...args: unknown[]) => void) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      off(event: string, handler: (...args: unknown[]) => void) {
        handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
      },
      evaluate: async () => harnessAlive(),
      emit(event: string, ...args: unknown[]) {
        for (const handler of handlers.get(event) ?? []) handler(...args);
      },
      listeners(event: string) {
        return handlers.get(event) ?? [];
      },
    };
  }

  it("closes a popup a click opened and reports the target as skipped", async () => {
    const page = fakePage(() => true);
    const watch = createEscapeWatch(page as never);
    let closed = false;
    page.emit("popup", { close: async () => { closed = true; } });

    expect(await watch.check()).toBe("opened-a-page");
    expect(closed).toBe(true);
    watch.stop();
  });

  it("leaves no popup listener behind once the combo is done", () => {
    const page = fakePage(() => true);
    const watch = createEscapeWatch(page as never);
    expect(page.listeners("popup")).toHaveLength(1);
    watch.stop();
    expect(page.listeners("popup")).toHaveLength(0);
  });

  it("reports a navigation that took the harness global with it", async () => {
    let alive = true;
    const page = fakePage(() => alive);
    const watch = createEscapeWatch(page as never);
    expect(await watch.check()).toBeUndefined();
    alive = false;
    expect(await watch.check()).toBe("left-the-page");
    watch.stop();
  });

  it("reads a same-origin route change as the component's own behaviour", async () => {
    const page = fakePage(() => true);
    const watch = createEscapeWatch(page as never);
    expect(await watch.check()).toBeUndefined();
    watch.stop();
  });

  it("does not read a destroyed execution context as a click that left", async () => {
    const page = {
      on() {},
      off() {},
      evaluate: async () => { throw new Error("Execution context was destroyed"); },
    };
    const watch = createEscapeWatch(page as never);
    expect(await watch.check()).toBeUndefined();
  });

  it("does not read a closed target as a click that left", async () => {
    const page = {
      on() {},
      off() {},
      evaluate: async () => { throw new Error("Target closed"); },
    };
    const watch = createEscapeWatch(page as never);
    expect(await watch.check()).toBeUndefined();
  });

  it("re-reads once before believing an unexplained read failure", async () => {
    let reads = 0;
    const page = {
      on() {},
      off() {},
      evaluate: async () => {
        reads++;
        if (reads === 1) throw new Error("something else went wrong");
        return false;
      },
    };
    const watch = createEscapeWatch(page as never);
    expect(await watch.check()).toBe("left-the-page");
    expect(reads).toBe(2);
  });

  it("reports nothing when the page stays unreadable", async () => {
    const page = {
      on() {},
      off() {},
      evaluate: async () => { throw new Error("something else went wrong"); },
    };
    const watch = createEscapeWatch(page as never);
    expect(await watch.check()).toBeUndefined();
  });

  it("forgets the previous target's popup when the next one starts", async () => {
    const page = fakePage(() => true);
    const watch = createEscapeWatch(page as never);
    page.emit("popup", { close: async () => {} });
    expect(await watch.check()).toBe("opened-a-page");
    watch.reset();
    expect(await watch.check()).toBeUndefined();
    watch.stop();
  });
});
