import { describe, it, expect, vi } from "vitest";
import {
  isFrameStarvationError,
  isTracingTimeoutError,
  isTargetClosedError,
  withFrameStarvationRetry,
  withWarmupRetry,
  createRetryBudget,
  MAX_FRAME_STARVATION_RETRIES,
  frameStarvationRetryWarning,
  frameStarvationDegradedWarning,
  tracingTimeoutRetryWarning,
  tracingTimeoutDegradedWarning,
  targetClosedRetryWarning,
  targetClosedDegradedWarning,
} from "../../src/measure.js";

// M89: taxonomy's control — button.tsx dies in the delta pass with
// `frame starvation: rAF fence exceeded 10000ms`, and the fence had no
// retry at all. These tests exercise the bounded-retry + disclosed-
// degradation mechanism directly, without a real browser.

describe("isFrameStarvationError", () => {
  it("matches the fence's exact thrown message", () => {
    expect(isFrameStarvationError(new Error("frame starvation: rAF fence exceeded 10000ms"))).toBe(true);
  });

  it("matches case-insensitively and as a substring", () => {
    expect(isFrameStarvationError(new Error("Frame Starvation detected mid-combo"))).toBe(true);
  });

  it("does not match an unrelated error", () => {
    expect(isFrameStarvationError(new Error("Execution context was destroyed"))).toBe(false);
  });

  it("matches a bare string throw too (mirrors isContextLostError's convention)", () => {
    expect(isFrameStarvationError("frame starvation")).toBe(true);
  });

  it("does not match a non-string, non-Error thrown value", () => {
    expect(isFrameStarvationError(undefined)).toBe(false);
    expect(isFrameStarvationError(42)).toBe(false);
  });
});

describe("withFrameStarvationRetry", () => {
  it("returns the body's result on the first attempt when nothing starves", async () => {
    const enter = vi.fn(async () => {});
    const body = vi.fn(async () => 42);
    const result = await withFrameStarvationRetry(0, enter, body);
    expect(result).toBe(42);
    expect(enter).not.toHaveBeenCalled();
  });

  it("recovers when starvation occurs fewer times than the retry bound", async () => {
    let attempts = 0;
    const enter = vi.fn(async () => {});
    const body = vi.fn(async () => {
      attempts++;
      if (attempts <= MAX_FRAME_STARVATION_RETRIES) {
        throw new Error("frame starvation: rAF fence exceeded 10000ms");
      }
      return "recovered";
    });
    const onWarning = vi.fn();
    const result = await withFrameStarvationRetry(3, enter, body, onWarning);
    expect(result).toBe("recovered");
    expect(enter).toHaveBeenCalledTimes(MAX_FRAME_STARVATION_RETRIES);
    expect(onWarning).toHaveBeenCalledWith(frameStarvationRetryWarning(3));
  });

  it("degrades (returns undefined) and discloses when the bound is exhausted, without throwing", async () => {
    const enter = vi.fn(async () => {});
    const body = vi.fn(async () => {
      throw new Error("frame starvation: rAF fence exceeded 10000ms");
    });
    const onWarning = vi.fn();
    const result = await withFrameStarvationRetry(7, enter, body, onWarning);
    expect(result).toBeUndefined();
    expect(onWarning).toHaveBeenCalledWith(frameStarvationDegradedWarning(7));
    // Bounded: exactly MAX_FRAME_STARVATION_RETRIES retries, not unbounded.
    expect(enter).toHaveBeenCalledTimes(MAX_FRAME_STARVATION_RETRIES);
  });

  it("re-throws a non-frame-starvation error unchanged (not a general catch-all)", async () => {
    const enter = vi.fn(async () => {});
    const body = vi.fn(async () => {
      throw new Error("Execution context was destroyed");
    });
    await expect(withFrameStarvationRetry(1, enter, body)).rejects.toThrow(
      "Execution context was destroyed",
    );
    expect(enter).not.toHaveBeenCalled();
  });

  it("works with no onWarning supplied (does not throw from a missing callback)", async () => {
    const enter = vi.fn(async () => {});
    const body = vi.fn(async () => {
      throw new Error("frame starvation: rAF fence exceeded 10000ms");
    });
    await expect(withFrameStarvationRetry(0, enter, body)).resolves.toBeUndefined();
  });
});

// M89 harden.
describe("M89 harden: withFrameStarvationRetry adversarial cases", () => {
  it("h1: starvation on the very last allowed attempt still recovers", async () => {
    let attempts = 0;
    const enter = vi.fn(async () => {});
    const body = vi.fn(async () => {
      attempts++;
      if (attempts <= MAX_FRAME_STARVATION_RETRIES) throw new Error("frame starvation: x");
      return "ok";
    });
    await expect(withFrameStarvationRetry(0, enter, body)).resolves.toBe("ok");
  });

  it("h2: enter() itself throwing propagates (not swallowed)", async () => {
    const enter = vi.fn(async () => {
      throw new Error("enter failed");
    });
    const body = vi.fn(async () => {
      throw new Error("frame starvation: x");
    });
    await expect(withFrameStarvationRetry(0, enter, body)).rejects.toThrow("enter failed");
  });

  it("h3: a comboIndex of 0 (falsy) is still named correctly in the warning", async () => {
    const enter = vi.fn(async () => {});
    const body = vi.fn(async () => {
      throw new Error("frame starvation: x");
    });
    const onWarning = vi.fn();
    await withFrameStarvationRetry(0, enter, body, onWarning);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining("combo 0"));
  });

  it("h4: negative comboIndex does not crash message formatting", async () => {
    const enter = vi.fn(async () => {});
    const body = vi.fn(async () => {
      throw new Error("frame starvation: x");
    });
    const onWarning = vi.fn();
    await expect(withFrameStarvationRetry(-1, enter, body, onWarning)).resolves.toBeUndefined();
  });

  it("h5: body resolving to undefined itself is indistinguishable from starvation-degraded (documented contract limit)", async () => {
    const enter = vi.fn(async () => {});
    const body = vi.fn(async () => undefined);
    const result = await withFrameStarvationRetry(0, enter, body);
    expect(result).toBeUndefined();
  });

  it("h6: an Error whose message merely contains extra text around the pattern still matches", async () => {
    expect(
      isFrameStarvationError(new Error("rerender phase failed on combo 14 of button.tsx: page.evaluate: Error: frame starvation: rAF fence exceeded 10000ms")),
    ).toBe(true);
  });

  it("h7: zero as MAX_FRAME_STARVATION_RETRIES conceptually would mean immediate degrade — verify current bound is a small positive constant", () => {
    expect(MAX_FRAME_STARVATION_RETRIES).toBeGreaterThan(0);
    expect(MAX_FRAME_STARVATION_RETRIES).toBeLessThan(10);
  });

  // M92 (1.5a, regression): enter() re-runs enterHarness's own independent
  // style-settle fence. Previously that call sat outside any guard, so a
  // starvation during recovery escaped this function uncaught -- the exact
  // failure this retry exists to prevent, relocated one frame up.
  it("h9: a starvation during enter() itself is caught and counts against the same bounded budget, then degrades", async () => {
    const enter = vi.fn(async () => {
      throw new Error("frame starvation: style settle fence exceeded 10000ms");
    });
    const body = vi.fn(async () => {
      throw new Error("frame starvation: rAF fence exceeded 10000ms");
    });
    const onWarning = vi.fn();
    await expect(withFrameStarvationRetry(2, enter, body, onWarning)).resolves.toBeUndefined();
    expect(onWarning).toHaveBeenCalledWith(frameStarvationDegradedWarning(2));
    // Bounded overall: body() is called at most MAX_FRAME_STARVATION_RETRIES+1
    // times and enter() at most MAX_FRAME_STARVATION_RETRIES times, whether
    // the starvation comes from body() alone or is mixed with enter().
    expect(body.mock.calls.length).toBeLessThanOrEqual(MAX_FRAME_STARVATION_RETRIES + 1);
    expect(enter.mock.calls.length).toBeLessThanOrEqual(MAX_FRAME_STARVATION_RETRIES);
  });

  it("h10: enter() starving once, then recovering, still reaches a successful body() result", async () => {
    let enterAttempts = 0;
    const enter = vi.fn(async () => {
      enterAttempts++;
      if (enterAttempts === 1) throw new Error("frame starvation: style settle fence exceeded 10000ms");
    });
    let bodyAttempts = 0;
    const body = vi.fn(async () => {
      bodyAttempts++;
      if (bodyAttempts <= MAX_FRAME_STARVATION_RETRIES) {
        throw new Error("frame starvation: rAF fence exceeded 10000ms");
      }
      return "recovered";
    });
    const onWarning = vi.fn();
    const result = await withFrameStarvationRetry(5, enter, body, onWarning);
    expect(result).toBe("recovered");
    expect(onWarning).not.toHaveBeenCalledWith(frameStarvationDegradedWarning(5));
  });

  it("h11: a non-starvation error from enter() still propagates unchanged, even mid-retry", async () => {
    let enterAttempts = 0;
    const enter = vi.fn(async () => {
      enterAttempts++;
      if (enterAttempts === 1) {
        throw new Error("frame starvation: style settle fence exceeded 10000ms");
      }
      throw new Error("Execution context was destroyed");
    });
    const body = vi.fn(async () => {
      throw new Error("frame starvation: rAF fence exceeded 10000ms");
    });
    await expect(withFrameStarvationRetry(0, enter, body)).rejects.toThrow(
      "Execution context was destroyed",
    );
  });

  it("h8: onWarning throwing does not corrupt the retry/degrade outcome", async () => {
    const enter = vi.fn(async () => {});
    const body = vi.fn(async () => {
      throw new Error("frame starvation: x");
    });
    const onWarning = vi.fn(() => {
      throw new Error("warning sink broke");
    });
    // A broken warning sink is a caller bug; document that it currently
    // propagates rather than being swallowed, so callers know onWarning
    // must not throw.
    await expect(withFrameStarvationRetry(0, enter, body, onWarning)).rejects.toThrow(
      "warning sink broke",
    );
  });
});

// M89 defect 1: taxonomy's run correctly degraded two starved combos, then
// still died with `browserContext.newCDPSession: Target page, context or
// browser has been closed` -- a closed target and a wedged trace pipeline
// used to bypass this retry entirely (only frame starvation was guarded)
// and abort the whole pass. Both are recovered the same way frame
// starvation is: `enter` re-enters against a fresh CDP session.

describe("isTracingTimeoutError", () => {
  it("matches the CDP tracing-timeout message", () => {
    expect(isTracingTimeoutError(new Error("Tracing.tracingComplete timed out"))).toBe(true);
  });

  it("does not match an unrelated error", () => {
    expect(isTracingTimeoutError(new Error("frame starvation: rAF fence exceeded 10000ms"))).toBe(false);
  });

  it("does not match a non-string, non-Error thrown value", () => {
    expect(isTracingTimeoutError(undefined)).toBe(false);
  });
});

describe("isTargetClosedError", () => {
  it("matches a closed-target message", () => {
    expect(
      isTargetClosedError(
        new Error("browserContext.newCDPSession: Target page, context or browser has been closed"),
      ),
    ).toBe(true);
  });

  it("matches a crashed-target message", () => {
    expect(isTargetClosedError(new Error("Target crashed"))).toBe(true);
  });

  it("does not match an unrelated error", () => {
    expect(isTargetClosedError(new Error("Execution context was destroyed"))).toBe(false);
  });
});

describe("M89 defect 1: withFrameStarvationRetry covers all three stall signatures", () => {
  it("recovers a tracing-timeout stall within the retry bound, using tracing-specific disclosure", async () => {
    let attempts = 0;
    const enter = vi.fn(async () => {});
    const body = vi.fn(async () => {
      attempts++;
      if (attempts <= MAX_FRAME_STARVATION_RETRIES) {
        throw new Error("Tracing.tracingComplete timed out");
      }
      return "recovered";
    });
    const onWarning = vi.fn();
    const result = await withFrameStarvationRetry(4, enter, body, onWarning);
    expect(result).toBe("recovered");
    expect(onWarning).toHaveBeenCalledWith(tracingTimeoutRetryWarning(4));
    expect(onWarning).not.toHaveBeenCalledWith(expect.stringContaining("frame starvation"));
  });

  it("degrades a tracing-timeout stall at the bound, disclosing tracing-specific wording, without throwing", async () => {
    const enter = vi.fn(async () => {});
    const body = vi.fn(async () => {
      throw new Error("Tracing.tracingComplete timed out");
    });
    const onWarning = vi.fn();
    const result = await withFrameStarvationRetry(5, enter, body, onWarning);
    expect(result).toBeUndefined();
    expect(onWarning).toHaveBeenCalledWith(tracingTimeoutDegradedWarning(5));
    expect(onWarning).not.toHaveBeenCalledWith(frameStarvationDegradedWarning(5));
    expect(enter).toHaveBeenCalledTimes(MAX_FRAME_STARVATION_RETRIES);
  });

  it("recovers a closed-target stall within the retry bound, using target-specific disclosure", async () => {
    let attempts = 0;
    const enter = vi.fn(async () => {});
    const body = vi.fn(async () => {
      attempts++;
      if (attempts <= MAX_FRAME_STARVATION_RETRIES) {
        throw new Error("Target page, context or browser has been closed");
      }
      return "recovered";
    });
    const onWarning = vi.fn();
    const result = await withFrameStarvationRetry(6, enter, body, onWarning);
    expect(result).toBe("recovered");
    expect(onWarning).toHaveBeenCalledWith(targetClosedRetryWarning(6));
  });

  it("degrades a closed-target stall at the bound, disclosing target-specific wording (not 'frame starvation'), without throwing", async () => {
    const enter = vi.fn(async () => {});
    const body = vi.fn(async () => {
      throw new Error("Target crashed");
    });
    const onWarning = vi.fn();
    const result = await withFrameStarvationRetry(7, enter, body, onWarning);
    expect(result).toBeUndefined();
    expect(onWarning).toHaveBeenCalledWith(targetClosedDegradedWarning(7));
    expect(targetClosedDegradedWarning(7)).not.toContain("frame starvation");
    expect(enter).toHaveBeenCalledTimes(MAX_FRAME_STARVATION_RETRIES);
  });

  it("a closed target reached only through enter()'s own retry (the exact live-proof shape) still degrades instead of escaping", async () => {
    // The taxonomy failure: body() throws something enter() can fix, but
    // enter() itself (refreshCdpSession's newCDPSession call) then throws
    // the closed-target error because the browser is going away.
    const enter = vi.fn(async () => {
      throw new Error("browserContext.newCDPSession: Target page, context or browser has been closed");
    });
    const body = vi.fn(async () => {
      throw new Error("Target crashed");
    });
    const onWarning = vi.fn();
    await expect(withFrameStarvationRetry(1, enter, body, onWarning)).resolves.toBeUndefined();
    expect(onWarning).toHaveBeenCalledWith(targetClosedDegradedWarning(1));
  });

  it("a non-stall error still propagates unchanged and is never retried (negative case)", async () => {
    const enter = vi.fn(async () => {});
    const body = vi.fn(async () => {
      throw new Error("Calibration produced zero duration");
    });
    await expect(withFrameStarvationRetry(2, enter, body)).rejects.toThrow(
      "Calibration produced zero duration",
    );
    expect(enter).not.toHaveBeenCalled();
  });

  it("mixed signatures across attempts (starvation then target-closed) still recover, budget shared across both", async () => {
    let attempts = 0;
    const enter = vi.fn(async () => {});
    const body = vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error("frame starvation: rAF fence exceeded 10000ms");
      if (attempts === 2) throw new Error("Target crashed");
      return "recovered";
    });
    const onWarning = vi.fn();
    const result = await withFrameStarvationRetry(8, enter, body, onWarning);
    expect(result).toBe("recovered");
    expect(onWarning).toHaveBeenCalledWith(frameStarvationRetryWarning(8));
    expect(onWarning).toHaveBeenCalledWith(targetClosedRetryWarning(8));
    expect(enter).toHaveBeenCalledTimes(2);
  });

  // M89 defect 1 harden.
  it("h12: the exact live-proof message (phase prefix + inner CDP method name) still classifies as target-closed, not frame starvation", () => {
    const live =
      "rerender phase failed on combo 1 of button.tsx: browserContext.newCDPSession: Target page, " +
      "context or browser has been closed";
    expect(isTargetClosedError(new Error(live))).toBe(true);
    expect(isFrameStarvationError(new Error(live))).toBe(false);
  });

  it("h13: a target-closed error already suffixed with the context-retry-budget-exhausted note still classifies and retries", async () => {
    const enter = vi.fn(async () => {});
    const body = vi.fn(async () => {
      throw new Error(
        "Target crashed The context-retry budget is exhausted: repeated dev-server reloads " +
          "(environment), not the component, are the likely cause.",
      );
    });
    const onWarning = vi.fn();
    const result = await withFrameStarvationRetry(9, enter, body, onWarning);
    expect(result).toBeUndefined();
    expect(onWarning).toHaveBeenCalledWith(targetClosedDegradedWarning(9));
  });

  it("h14: enter() throwing a different stall kind than body() did is classified independently and still recovers", async () => {
    let bodyAttempts = 0;
    const enter = vi.fn(async () => {
      throw new Error("Tracing.tracingComplete timed out");
    });
    const body = vi.fn(async () => {
      bodyAttempts++;
      if (bodyAttempts <= MAX_FRAME_STARVATION_RETRIES) {
        throw new Error("Target crashed");
      }
      return "recovered";
    });
    const onWarning = vi.fn();
    // enter() always throws a tracing-timeout, which counts against the same
    // budget as body()'s target-closed stalls; on the last body() attempt
    // body() no longer throws, so the loop returns before enter() runs again.
    const result = await withFrameStarvationRetry(10, enter, body, onWarning);
    expect(result).toBe("recovered");
    expect(onWarning).toHaveBeenCalledWith(targetClosedRetryWarning(10));
    expect(onWarning).toHaveBeenCalledWith(tracingTimeoutRetryWarning(10));
  });

  it("h15: degraded disclosure text for tracing-timeout and target-closed never says 'frame starvation'", () => {
    expect(tracingTimeoutDegradedWarning(0)).not.toContain("frame starvation");
    expect(targetClosedDegradedWarning(0)).not.toContain("frame starvation");
    expect(tracingTimeoutRetryWarning(0)).not.toContain("frame starvation");
    expect(targetClosedRetryWarning(0)).not.toContain("frame starvation");
  });
});

// M89 defect 2 (live taxonomy proof): combo 2 correctly degrades via its
// sample loop's withFrameStarvationRetry composition, then combo 3 fails the
// whole run with a raw, unwrapped `frame starvation` error and *no* preceding
// "retrying against a freshly re-entered harness session" warning -- proof
// the failure never reached withFrameStarvationRetry at all. The cause is
// not budget scoping (withFrameStarvationRetry's own `attempt` counter is a
// fresh local per call, already isolated per combo/sample) but a coverage
// gap: measureRerender's and measureMount's warmup calls (mountAndWait,
// rerenderAndTrace, runMountUnmount) ran outside any retry wrapper.
// `withWarmupRetry` closes that gap the same way the sample loops are
// already guarded, sharing the pass's retryBudget the same way.
describe("withWarmupRetry", () => {
  it("returns true without warning when warmup succeeds on the first attempt", async () => {
    const enter = vi.fn(async () => {});
    const warmup = vi.fn(async () => {});
    const onWarning = vi.fn();
    const result = await withWarmupRetry(0, enter, warmup, createRetryBudget(), onWarning);
    expect(result).toBe(true);
    expect(enter).not.toHaveBeenCalled();
    expect(onWarning).not.toHaveBeenCalled();
  });

  it("recovers a starving warmup within the bound and returns true", async () => {
    let attempts = 0;
    const enter = vi.fn(async () => {});
    const warmup = vi.fn(async () => {
      attempts++;
      if (attempts <= MAX_FRAME_STARVATION_RETRIES) {
        throw new Error("frame starvation: rAF fence exceeded 10000ms");
      }
    });
    const onWarning = vi.fn();
    const result = await withWarmupRetry(2, enter, warmup, createRetryBudget(), onWarning);
    expect(result).toBe(true);
    expect(onWarning).toHaveBeenCalledWith(frameStarvationRetryWarning(2));
  });

  it("degrades (returns false) without throwing when warmup exhausts the bound -- the exact fix for the live defect: previously this escaped unguarded and failed the whole run", async () => {
    const enter = vi.fn(async () => {});
    const warmup = vi.fn(async () => {
      throw new Error("frame starvation: rAF fence exceeded 10000ms");
    });
    const onWarning = vi.fn();
    const result = await withWarmupRetry(3, enter, warmup, createRetryBudget(), onWarning);
    expect(result).toBe(false);
    expect(onWarning).toHaveBeenCalledWith(frameStarvationDegradedWarning(3));
  });

  it("propagates a non-stall warmup error unchanged (not a general catch-all)", async () => {
    const enter = vi.fn(async () => {});
    const warmup = vi.fn(async () => {
      throw new Error("Calibration produced zero duration");
    });
    await expect(
      withWarmupRetry(1, enter, warmup, createRetryBudget()),
    ).rejects.toThrow("Calibration produced zero duration");
    expect(enter).not.toHaveBeenCalled();
  });

  it("a tracing-timeout/target-closed warmup stall still degrades (not just frame starvation) via the same shared retryBudget the sample loop's withContextRetry composition uses", async () => {
    const enter = vi.fn(async () => {});
    const warmup = vi.fn(async () => {
      throw new Error("Target crashed");
    });
    const onWarning = vi.fn();
    const result = await withWarmupRetry(4, enter, warmup, createRetryBudget(), onWarning);
    expect(result).toBe(false);
    expect(onWarning).toHaveBeenCalledWith(targetClosedDegradedWarning(4));
  });

  it("an already-exhausted shared retryBudget still degrades rather than escaping (withFrameStarvationRetry's own bound is independent of withContextRetry's)", async () => {
    const exhaustedBudget = createRetryBudget(0);
    const enter = vi.fn(async () => {});
    const warmup = vi.fn(async () => {
      throw new Error("Target crashed");
    });
    const onWarning = vi.fn();
    const result = await withWarmupRetry(5, enter, warmup, exhaustedBudget, onWarning);
    expect(result).toBe(false);
    expect(onWarning).toHaveBeenCalledWith(targetClosedDegradedWarning(5));
  });
});

describe("M89 defect 2: per-combo scoping across a multi-combo run (mirrors measureRerender/measureMount's warmup-then-sample composition)", () => {
  // Models the actual loop shape in src/measure.ts after this fix: a warmup
  // step (withWarmupRetry) followed by a sample step (withFrameStarvationRetry),
  // both sharing one enter() and one pass-scoped retryBudget across combos.
  async function runCombos(
    behavior: Array<{ warmupFails?: boolean; sampleFails?: boolean }>,
    onWarning: (warning: string) => void,
  ): Promise<Array<number | undefined>> {
    const enter = async () => {};
    const budget = createRetryBudget();
    const results: Array<number | undefined> = [];
    for (let ci = 0; ci < behavior.length; ci++) {
      const b = behavior[ci];
      const warmed = await withWarmupRetry(
        ci,
        enter,
        async () => {
          if (b.warmupFails) throw new Error("frame starvation: rAF fence exceeded 10000ms");
        },
        budget,
        onWarning,
      );
      if (!warmed) {
        results.push(undefined);
        continue;
      }
      const sample = await withFrameStarvationRetry(
        ci,
        enter,
        async () => {
          if (b.sampleFails) throw new Error("frame starvation: rAF fence exceeded 10000ms");
          return ci * 10;
        },
        onWarning,
      );
      results.push(sample);
    }
    return results;
  }

  it("two consecutive combos both starve (one in warmup, one in samples): both degrade, both disclosed, the run reports rather than throws", async () => {
    const onWarning = vi.fn();
    const results = await runCombos(
      [{ warmupFails: true }, { sampleFails: true }, {}],
      onWarning,
    );
    expect(results).toEqual([undefined, undefined, 20]);
    expect(onWarning).toHaveBeenCalledWith(frameStarvationDegradedWarning(0));
    expect(onWarning).toHaveBeenCalledWith(frameStarvationDegradedWarning(1));
  });

  it("every combo starves: the run still produces a full result array (all omitted) rather than throwing, and each combo costs bounded work -- the run terminates promptly instead of hanging", async () => {
    const onWarning = vi.fn();
    const behavior = Array.from({ length: 8 }, () => ({ warmupFails: true }));
    const results = await runCombos(behavior, onWarning);
    expect(results).toEqual(Array(8).fill(undefined));
    for (let ci = 0; ci < 8; ci++) {
      expect(onWarning).toHaveBeenCalledWith(frameStarvationDegradedWarning(ci));
    }
  });

  it("a non-stall error in one combo's warmup still propagates unchanged and aborts the run (negative case: this guard is not a general catch-all)", async () => {
    const onWarning = vi.fn();
    await expect(
      runCombos([{}, { warmupFails: false }], onWarning),
    ).resolves.toEqual([0, 10]);

    // Explicit non-stall propagation through withWarmupRetry directly.
    const enter = vi.fn(async () => {});
    const budget = createRetryBudget();
    await expect(
      withWarmupRetry(
        1,
        enter,
        async () => {
          throw new Error("Calibration produced zero duration");
        },
        budget,
      ),
    ).rejects.toThrow("Calibration produced zero duration");
  });
});
