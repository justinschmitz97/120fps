import { describe, it, expect } from "vitest";
import {
  detectMemoBailouts,
  detectMemoBailoutsFromSnapshot,
  diffSnapshots,
  snapshotHasMemoFiber,
  type FiberInfo,
  type ProfilerSnapshot,
} from "../../src/analysis/index.js";

function snapshot(fibers: Array<Partial<FiberInfo> & { name: string; renderCount: number }>): ProfilerSnapshot {
  return {
    fibers: new Map(
      fibers.map((f) => [
        f.name,
        {
          name: f.name,
          renderCount: f.renderCount,
          actualDurationMs: f.actualDurationMs ?? 1,
          selfDurationMs: f.selfDurationMs ?? 1,
          descendantCount: f.descendantCount ?? 0,
          isMemo: f.isMemo ?? false,
        },
      ]),
    ),
    commitCount: 1,
  };
}

const WITHOUT_MEMO = snapshot([
  { name: "Card", renderCount: 1 },
  { name: "CardHeader", renderCount: 1 },
]);
const WITH_MEMO = snapshot([
  { name: "Card", renderCount: 1 },
  { name: "MemoRow", renderCount: 1, isMemo: true },
]);
const AFTER_RERENDER = snapshot([
  { name: "Card", renderCount: 2 },
  { name: "MemoRow", renderCount: 2, isMemo: true },
]);

describe("the snapshot the memo pass reads", () => {
  it("sees no memo fiber in a tree with none", () => {
    expect(snapshotHasMemoFiber(WITHOUT_MEMO)).toBe(false);
  });

  it("sees the memo fiber in a tree that has one", () => {
    expect(snapshotHasMemoFiber(WITH_MEMO)).toBe(true);
  });

  it("does not count a memoized fiber the report would never name", () => {
    expect(snapshotHasMemoFiber(snapshot([{ name: "__120fps_Boundary", renderCount: 1, isMemo: true }]))).toBe(false);
    expect(snapshotHasMemoFiber(snapshot([{ name: "_c1", renderCount: 1, isMemo: true }]))).toBe(false);
  });

  it("sees no memo fiber in an empty snapshot", () => {
    expect(snapshotHasMemoFiber(snapshot([]))).toBe(false);
  });
});

describe("the memo pass", () => {
  it("runs no rerender and returns the empty result when the tree has no memo fiber", async () => {
    let rerenders = 0;

    const result = await detectMemoBailoutsFromSnapshot(WITHOUT_MEMO, {
      rerenderAndCollect: async () => {
        rerenders += 1;
        return AFTER_RERENDER;
      },
    });

    expect(rerenders).toBe(0);
    expect(result).toEqual([]);
  });

  it("runs one rerender and reports what the per-combo pass reported when a memo fiber is there", async () => {
    let rerenders = 0;

    const result = await detectMemoBailoutsFromSnapshot(WITH_MEMO, {
      rerenderAndCollect: async () => {
        rerenders += 1;
        return AFTER_RERENDER;
      },
    });

    expect(rerenders).toBe(1);
    expect(result).toEqual(detectMemoBailouts(diffSnapshots(WITH_MEMO, AFTER_RERENDER)));
    expect(result).toEqual(["MemoRow"]);
  });
});
