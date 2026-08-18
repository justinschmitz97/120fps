import { describe, it, expect } from "vitest";
import {
  isContextLostError,
  withContextRetry,
  createRetryBudget,
  CONTEXT_RETRY_WARNING,
  DEFAULT_RETRY_BUDGET,
} from "../../src/measure.js";

describe("a dev-server reload does not kill a run", () => {
  it("recognizes a destroyed execution context", () => {
    expect(
      isContextLostError(
        new Error("page.evaluate: Execution context was destroyed, most likely because of a navigation."),
      ),
    ).toBe(true);
  });

  it("recognizes the control API disappearing", () => {
    expect(
      isContextLostError(new Error("page.evaluate: TypeError: Cannot read properties of undefined (reading 'unmount')")),
    ).toBe(true);
  });

  // CDP session recovery (see test/unit/cdp-session-recovery.test.ts) made
  // this retryable again: `enter` now replaces the wedged CDP session
  // instead of only re-navigating.
  it("treats a tracing timeout as a retryable context loss", () => {
    expect(isContextLostError(new Error("Tracing.tracingComplete timed out"))).toBe(true);
  });

  it("does not claim unrelated failures", () => {
    expect(isContextLostError(new Error("component threw during render"))).toBe(false);
    expect(isContextLostError(undefined)).toBe(false);
    expect(isContextLostError("Execution context was destroyed")).toBe(true);
  });

  it("returns the body result untouched when nothing goes wrong", async () => {
    let entered = 0;
    const result = await withContextRetry(
      async () => {
        entered++;
      },
      async () => 42,
    );
    expect(result).toBe(42);
    expect(entered).toBe(0);
  });

  it("re-enters and retries exactly once on a lost context", async () => {
    let entered = 0;
    let attempts = 0;
    const result = await withContextRetry(
      async () => {
        entered++;
      },
      async () => {
        attempts++;
        if (attempts === 1) throw new Error("Execution context was destroyed");
        return "second";
      },
    );
    expect(result).toBe("second");
    expect(entered).toBe(1);
    expect(attempts).toBe(2);
  });

  it("gives up after one retry", async () => {
    let attempts = 0;
    await expect(
      withContextRetry(
        async () => {},
        async () => {
          attempts++;
          throw new Error("Execution context was destroyed");
        },
      ),
    ).rejects.toThrow("Execution context was destroyed");
    expect(attempts).toBe(2);
  });

  it("rethrows an unrelated error without retrying", async () => {
    let attempts = 0;
    await expect(
      withContextRetry(
        async () => {},
        async () => {
          attempts++;
          throw new Error("component threw during render");
        },
      ),
    ).rejects.toThrow("component threw during render");
    expect(attempts).toBe(1);
  });

  it("reports that a retry was consumed", async () => {
    const consumed: string[] = [];
    await withContextRetry(
      async () => {},
      async () => {
        if (consumed.length === 0) throw new Error("Execution context was destroyed");
        return 1;
      },
      { onRetry: (w) => consumed.push(w) },
    );
    expect(consumed).toEqual([CONTEXT_RETRY_WARNING]);
  });
});

describe("the retry budget bounds amplification", () => {
  it("stops retrying once the pass budget is spent", async () => {
    const budget = createRetryBudget(1);
    let attempts = 0;
    const body = async () => {
      attempts++;
      throw new Error("Execution context was destroyed");
    };
    await expect(withContextRetry(async () => {}, body, { budget })).rejects.toThrow();
    expect(attempts).toBe(2);
    expect(budget.remaining).toBe(0);

    attempts = 0;
    await expect(withContextRetry(async () => {}, body, { budget })).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it("does not spend budget on a successful body", async () => {
    const budget = createRetryBudget(2);
    await withContextRetry(async () => {}, async () => 1, { budget });
    expect(budget.remaining).toBe(2);
  });

  it("does not spend budget on an unrelated error", async () => {
    const budget = createRetryBudget(2);
    await expect(
      withContextRetry(async () => {}, async () => {
        throw new Error("component threw during render");
      }, { budget }),
    ).rejects.toThrow("component threw during render");
    expect(budget.remaining).toBe(2);
  });

  it("retries without limit when no budget is supplied", async () => {
    let attempts = 0;
    const result = await withContextRetry(async () => {}, async () => {
      attempts++;
      if (attempts === 1) throw new Error("Execution context was destroyed");
      return "ok";
    });
    expect(result).toBe("ok");
  });

  it("ships a default budget small enough to fail fast", () => {
    expect(DEFAULT_RETRY_BUDGET).toBe(2);
  });
});

describe("harden: context loss detection", () => {
  it("H23 a component render error is not a lost context", () => {
    expect(isContextLostError(new Error("Cannot read properties of undefined (reading 'map')"))).toBe(false);
  });

  it("H24 a missing selector is not a lost context", () => {
    expect(isContextLostError(new Error("locator.click: Timeout 3000ms exceeded"))).toBe(false);
  });

  it("H25 a non-Error object is not a lost context", () => {
    expect(isContextLostError({ message: "Execution context was destroyed" })).toBe(false);
  });

  it("H26 calibration failure is not a lost context", () => {
    expect(isContextLostError(new Error("Calibration produced zero duration"))).toBe(false);
  });
});
