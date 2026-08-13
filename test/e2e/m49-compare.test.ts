import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { compareAgainstRef } from "../../src/compare.js";

function gitClean(): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Compare refuses to run when the two sides' lockfiles differ, because the
// reference side resolves through the working tree's install. A tree with
// uncommitted dependency changes cannot exercise the happy path — that is the
// guard working, not a failure to test around.
function lockfileMatchesHead(): boolean {
  try {
    execFileSync("git", ["diff", "--quiet", "HEAD", "--", "pnpm-lock.yaml", "package.json"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const COMPARABLE = gitClean() && lockfileMatchesHead();

// Compares a committed fixture against HEAD. The working tree copy is
// unmodified, so this measures the machinery, not a change.
describe("m49 — interleaved compare against a git ref", () => {
  it.skipIf(!COMPARABLE)(
    "measures both sides and reports a delta",
    async () => {
      const report = await compareAgainstRef("./fixtures/button.tsx", "HEAD", {
        samples: 3,
        warmupRuns: 1,
        maxCombos: 1,
      });

      expect(report.ref).toBe("HEAD");
      expect(report.componentPath).toBe("fixtures/button.tsx");
      expect(report.combos).toHaveLength(1);

      const combo = report.combos[0];
      expect(combo.working.mountSamples).toHaveLength(3);
      expect(combo.reference.mountSamples).toHaveLength(3);
      expect(combo.working.mountMedian).toBeGreaterThan(0);
      expect(combo.reference.mountMedian).toBeGreaterThan(0);
      // Same source on both sides: the DOM cannot differ.
      expect(combo.working.domNodeCount).toBe(combo.reference.domNodeCount);
      expect(Number.isFinite(combo.mountDeltaPercent)).toBe(true);
    },
    600000,
  );

  it.skipIf(!COMPARABLE)(
    "removes its worktree on every exit path",
    async () => {
      const before = execFileSync("git", ["worktree", "list"], { encoding: "utf-8" });
      await compareAgainstRef("./fixtures/button.tsx", "HEAD", {
        samples: 1,
        warmupRuns: 0,
        maxCombos: 1,
      }).catch(() => undefined);
      const after = execFileSync("git", ["worktree", "list"], { encoding: "utf-8" });
      expect(after.split("\n").length).toBe(before.split("\n").length);
      expect(after).not.toContain("120fps-compare");
    },
    600000,
  );

  it.skipIf(!COMPARABLE)(
    "refuses a ref that does not exist, without leaving a worktree behind",
    async () => {
      await expect(
        compareAgainstRef("./fixtures/button.tsx", "no-such-ref-xyz", { samples: 1 }),
      ).rejects.toThrow(/no such commit/);
      expect(execFileSync("git", ["worktree", "list"], { encoding: "utf-8" }))
        .not.toContain("120fps-compare");
    },
    120000,
  );

  it.skipIf(!COMPARABLE)(
    "reports a component that does not exist at the ref",
    async () => {
      await expect(
        compareAgainstRef("./fixtures/m47-stable-tree.tsx", "HEAD", { samples: 1 }),
      ).rejects.toThrow(/does not exist at HEAD/);
    },
    120000,
  );
});
