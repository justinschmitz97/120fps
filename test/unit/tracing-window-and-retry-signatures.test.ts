import { describe, it, expect, vi, afterEach } from "vitest";
import {
  collectTrace,
  withContextRetry,
  createRetryBudget,
  TRACE_FLUSH_TIMEOUT_MS,
  CONTEXT_RETRY_WARNING,
  TRACING_STALL_RETRY_WARNING,
  TARGET_CLOSED_RETRY_WARNING,
  contextRetryWarningFor,
  retryBudgetExhaustedNoteFor,
  RETRY_BUDGET_EXHAUSTED_NOTE,
  TRACING_BUDGET_EXHAUSTED_NOTE,
  TARGET_CLOSED_BUDGET_EXHAUSTED_NOTE,
} from "../../src/measure.js";

type Handler = (payload: unknown) => void;

function fakeCdp() {
  const once = new Map<string, Handler[]>();
  const on = new Map<string, Handler[]>();
  const sent: string[] = [];
  return {
    sent,
    timerCountAtEnd: -1,
    on(event: string, fn: Handler) {
      on.set(event, [...(on.get(event) ?? []), fn]);
    },
    off(event: string, fn: Handler) {
      on.set(event, (on.get(event) ?? []).filter((h) => h !== fn));
    },
    once(event: string, fn: Handler) {
      once.set(event, [...(once.get(event) ?? []), fn]);
    },
    async send(method: string) {
      sent.push(method);
      if (method !== "Tracing.end") return;
      // Only meaningful under fake timers; real-timer tests do not read it.
      try {
        this.timerCountAtEnd = vi.getTimerCount();
      } catch {
        this.timerCountAtEnd = -1;
      }
    },
    complete() {
      for (const fn of once.get("Tracing.tracingComplete") ?? []) fn(undefined);
      once.delete("Tracing.tracingComplete");
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// calcom-F3: the 60 s timer was armed before `Tracing.start`, so it covered the
// traced action. An `open-close-10` pattern on a Radix portal spent 57 s in 19
// timed-out clicks and reported itself as a tracing stall, exit 2, no report.

describe("the window the tracing timeout bounds", () => {
  it("does not fire while the traced action is still running", async () => {
    vi.useFakeTimers();
    const cdp = fakeCdp();
    let acted = false;

    const traced = collectTrace(cdp as never, async () => {
      await vi.advanceTimersByTimeAsync(TRACE_FLUSH_TIMEOUT_MS * 2);
      acted = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    cdp.complete();

    await expect(traced).resolves.toEqual([]);
    expect(acted).toBe(true);
  });

  it("arms no timer at all until Tracing.end is sent", async () => {
    vi.useFakeTimers();
    const cdp = fakeCdp();
    let duringAction = -1;

    const traced = collectTrace(cdp as never, async () => {
      duringAction = vi.getTimerCount();
    });
    await vi.advanceTimersByTimeAsync(0);
    cdp.complete();
    await traced;

    expect(duringAction).toBe(0);
    expect(cdp.timerCountAtEnd).toBe(1);
  });

  it("still fires when the flush itself never completes", async () => {
    vi.useFakeTimers();
    const cdp = fakeCdp();

    const traced = collectTrace(cdp as never, async () => {});
    const assertion = expect(traced).rejects.toThrow(/Tracing\.tracingComplete timed out/);
    await vi.advanceTimersByTimeAsync(TRACE_FLUSH_TIMEOUT_MS + 1);
    await assertion;
  });

  it("ends tracing even when the action throws", async () => {
    const cdp = fakeCdp();

    await expect(
      collectTrace(cdp as never, async () => {
        throw new Error("click timed out");
      }),
    ).rejects.toThrow("click timed out");
    expect(cdp.sent.filter((m) => m === "Tracing.end").length).toBeGreaterThanOrEqual(1);
  });
});

// The same retry layer covers three signatures and named only one of them.

describe("which signature a retry warning names", () => {
  it("names a dev-server reload only for a lost execution context", () => {
    expect(contextRetryWarningFor(new Error("Execution context was destroyed"))).toBe(
      CONTEXT_RETRY_WARNING,
    );
  });

  it("names the trace pipeline for a tracing stall", () => {
    const warning = contextRetryWarningFor(new Error("Tracing.tracingComplete timed out"));
    expect(warning).toBe(TRACING_STALL_RETRY_WARNING);
    expect(warning).not.toContain("dev server");
  });

  it("names the browser target for a closed target", () => {
    expect(contextRetryWarningFor(new Error("Target page crashed"))).toBe(
      TARGET_CLOSED_RETRY_WARNING,
    );
  });

  it("reaches the caller from withContextRetry", async () => {
    const seen: string[] = [];
    let first = true;
    await withContextRetry(
      async () => {},
      async () => {
        if (first) {
          first = false;
          throw new Error("Tracing.tracingComplete timed out");
        }
        return 1;
      },
      { onRetry: (w) => seen.push(w) },
    );

    expect(seen).toEqual([TRACING_STALL_RETRY_WARNING]);
  });
});

describe("which cause an exhausted retry budget names", () => {
  it("blames reloads only for a lost execution context", () => {
    expect(retryBudgetExhaustedNoteFor(new Error("Execution context was destroyed"))).toBe(
      RETRY_BUDGET_EXHAUSTED_NOTE,
    );
  });

  it("blames the trace for a tracing stall", () => {
    expect(retryBudgetExhaustedNoteFor(new Error("Tracing.tracingComplete timed out"))).toBe(
      TRACING_BUDGET_EXHAUSTED_NOTE,
    );
  });

  it("blames the target for a closed target", () => {
    expect(retryBudgetExhaustedNoteFor(new Error("Target closed"))).toBe(
      TARGET_CLOSED_BUDGET_EXHAUSTED_NOTE,
    );
  });

  it("carries that cause into the thrown message", async () => {
    const budget = createRetryBudget(0);

    await expect(
      withContextRetry(
        async () => {},
        async () => {
          throw new Error("Tracing.tracingComplete timed out");
        },
        { budget },
      ),
    ).rejects.toThrow(/trace kept stalling/);
  });
});
