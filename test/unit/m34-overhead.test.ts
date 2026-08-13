import { describe, it, expect } from "vitest";
import { suspendThrottle } from "../../src/measure.js";

interface SentCommand {
  method: string;
  params?: Record<string, unknown>;
}

function fakeCdp(log: SentCommand[], fail?: (method: string) => boolean) {
  return {
    send: async (method: string, params?: Record<string, unknown>) => {
      if (fail?.(method)) throw new Error(`send failed: ${method}`);
      log.push({ method, params });
    },
  } as never;
}

// M34: the CPU throttle may be suspended for inter-sample bookkeeping, but must
// be restored before the next traced window.
describe("M34: suspendThrottle", () => {
  it("drops the rate to 1 around fn and restores the given rate", async () => {
    const log: SentCommand[] = [];
    const result = await suspendThrottle(fakeCdp(log), 4, async () => {
      log.push({ method: "__fn__" });
      return 7;
    });

    expect(result).toBe(7);
    expect(log).toEqual([
      { method: "Emulation.setCPUThrottlingRate", params: { rate: 1 } },
      { method: "__fn__" },
      { method: "Emulation.setCPUThrottlingRate", params: { rate: 4 } },
    ]);
  });

  it("restores the rate when fn throws", async () => {
    const log: SentCommand[] = [];
    await expect(
      suspendThrottle(fakeCdp(log), 6, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(log[log.length - 1]).toEqual({
      method: "Emulation.setCPUThrottlingRate",
      params: { rate: 6 },
    });
  });

  it("restores rate 1 when the session runs unthrottled (HH1)", async () => {
    const log: SentCommand[] = [];
    await suspendThrottle(fakeCdp(log), 1, async () => {});
    expect(log).toEqual([
      { method: "Emulation.setCPUThrottlingRate", params: { rate: 1 } },
      { method: "Emulation.setCPUThrottlingRate", params: { rate: 1 } },
    ]);
  });

  it("propagates a failed suspend without running fn", async () => {
    // Call sites sit inside withContextRetry: a dead session propagates, the
    // retry re-enters the harness (which re-engages the throttle), and the
    // whole sample body — GC included — runs again. Nothing may run at an
    // unknown throttle state.
    const log: SentCommand[] = [];
    let ran = false;
    await expect(
      suspendThrottle(
        fakeCdp(log, (m) => m === "Emulation.setCPUThrottlingRate"),
        4,
        async () => {
          ran = true;
        },
      ),
    ).rejects.toThrow();
    expect(ran).toBe(false);
  });
});
