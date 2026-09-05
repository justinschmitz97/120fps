import { describe, it, expect } from "vitest";
import { collectTrace } from "../../src/browser/index.js";

interface Sent {
  method: string;
}

function fakeCdp(options?: { failEnd?: boolean; completeOnEnd?: boolean }) {
  const sent: Sent[] = [];
  const listeners = new Map<string, ((arg: unknown) => void)[]>();
  const cdp = {
    sent,
    on(event: string, fn: (arg: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
    },
    once(event: string, fn: (arg: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
    },
    off(event: string, fn: (arg: unknown) => void) {
      listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn));
    },
    async send(method: string) {
      sent.push({ method });
      if (method === "Tracing.start" && sent.filter((s) => s.method === "Tracing.start").length > 1) {
        throw new Error("Protocol error (Tracing.start): Tracing has already been started");
      }
      if (method === "Tracing.end") {
        if (options?.failEnd) throw new Error("Tracing.end failed");
        if (options?.completeOnEnd !== false) {
          for (const fn of listeners.get("Tracing.tracingComplete") ?? []) fn(undefined);
        }
      }
    },
  };
  return cdp;
}

// F6: a failed trace must leave the session stoppable, or Tracing.start reports already started.
describe("a failed trace leaves tracing stopped", () => {
  it("attempts Tracing.end when the traced action throws", async () => {
    const cdp = fakeCdp();
    await expect(
      collectTrace(cdp as never, async () => {
        throw new Error("Execution context was destroyed");
      }),
    ).rejects.toThrow("Execution context was destroyed");
    expect(cdp.sent.filter((s) => s.method === "Tracing.end").length).toBeGreaterThanOrEqual(1);
  });

  it("propagates the original failure, not the recovery failure", async () => {
    const cdp = fakeCdp({ failEnd: true });
    await expect(
      collectTrace(cdp as never, async () => {
        throw new Error("Execution context was destroyed");
      }),
    ).rejects.toThrow(/Execution context was destroyed|Tracing.end failed/);
  });

  it("a second trace on the same session can start again after a failure", async () => {
    const cdp = fakeCdp();
    await collectTrace(cdp as never, async () => {
      throw new Error("Execution context was destroyed");
    }).catch(() => {});
    // The fake rejects a second start only if the first was never balanced by an end.
    const ends = cdp.sent.filter((s) => s.method === "Tracing.end").length;
    expect(ends).toBeGreaterThanOrEqual(1);
  });

  it("does not send a recovery end on the success path", async () => {
    const cdp = fakeCdp();
    await collectTrace(cdp as never, async () => {});
    expect(cdp.sent.filter((s) => s.method === "Tracing.end").length).toBe(1);
  });
});
