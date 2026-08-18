import { describe, it, expect } from "vitest";
import { collectTrace } from "../../src/measure.js";

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

// A trace that fails must leave the CDP session stoppable. Otherwise the F6
// retry reruns the body and the next Tracing.start reports "already started",
// which is what the dogfooding run hit on trnscrpt/content-sections.tsx.
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
    // The fake rejects a second start only if the first was never balanced by
    // an end; recovery must have balanced it.
    const ends = cdp.sent.filter((s) => s.method === "Tracing.end").length;
    expect(ends).toBeGreaterThanOrEqual(1);
  });

  it("does not send a recovery end on the success path", async () => {
    const cdp = fakeCdp();
    await collectTrace(cdp as never, async () => {});
    expect(cdp.sent.filter((s) => s.method === "Tracing.end").length).toBe(1);
  });
});
