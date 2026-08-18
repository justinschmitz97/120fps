import { describe, it, expect, vi } from "vitest";
import {
  createFramePump,
  MEASUREMENT_BROWSER_ARGS,
  FRAME_PUMP_WARNING,
} from "../../src/measure.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface MockSession {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
}

function okSession(): { session: MockSession; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    session: {
      send: async (method: string) => {
        calls.push(method);
        await sleep(1);
        return {};
      },
    },
  };
}

describe("MEASUREMENT_BROWSER_ARGS", () => {
  it("carries exactly the begin-frame-control flags", () => {
    expect(MEASUREMENT_BROWSER_ARGS).toEqual([
      "--enable-begin-frame-control",
      "--run-all-compositor-stages-before-draw",
    ]);
  });
});

describe("FRAME_PUMP_WARNING", () => {
  it("is a non-empty warning naming the vsync fallback", () => {
    expect(FRAME_PUMP_WARNING).toMatch(/vsync/i);
  });
});

describe("createFramePump", () => {
  it("sends beginFrame continuously until stopped, then stops sending", async () => {
    const { session, calls } = okSession();
    const pump = createFramePump({ cdp: session });
    // Windows timer granularity is ~15ms, so the mock's 1ms sleep really
    // takes ~15ms per frame: windows are sized for that.
    await sleep(150);
    await pump.stop();
    const countAtStop = calls.length;
    expect(countAtStop).toBeGreaterThanOrEqual(3);
    expect(calls.every((m) => m === "HeadlessExperimental.beginFrame")).toBe(true);
    await sleep(20);
    expect(calls.length).toBe(countAtStop);
    expect(pump.disabled).toBe(false);
  });

  it("reads the session from the holder each frame, surviving a session swap", async () => {
    const a = okSession();
    const b = okSession();
    const holder = { cdp: a.session };
    const pump = createFramePump(holder);
    await sleep(75);
    holder.cdp = b.session;
    await sleep(75);
    await pump.stop();
    expect(a.calls.length).toBeGreaterThanOrEqual(1);
    expect(b.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("continues through a transient error without disabling", async () => {
    let n = 0;
    const calls: string[] = [];
    const session: MockSession = {
      send: async (method: string) => {
        calls.push(method);
        n++;
        if (n === 2) throw new Error("transient");
        await sleep(1);
        return {};
      },
    };
    const pump = createFramePump({ cdp: session }, { backoffMs: 1 });
    await sleep(150);
    await pump.stop();
    expect(calls.length).toBeGreaterThan(3);
    expect(pump.disabled).toBe(false);
  });

  it("disables after maxConsecutiveErrors and reports it once", async () => {
    const onDisable = vi.fn();
    const session: MockSession = {
      send: async () => {
        throw new Error("Command is only supported with --run-all-compositor-stages-before-draw");
      },
    };
    const pump = createFramePump(
      { cdp: session },
      { maxConsecutiveErrors: 3, backoffMs: 1, onDisable },
    );
    await sleep(40);
    expect(pump.disabled).toBe(true);
    expect(onDisable).toHaveBeenCalledTimes(1);
    await pump.stop();
  });

  it("stop() is idempotent and resolves after disable", async () => {
    const session: MockSession = {
      send: async () => {
        throw new Error("boom");
      },
    };
    const pump = createFramePump(
      { cdp: session },
      { maxConsecutiveErrors: 1, backoffMs: 1 },
    );
    await sleep(15);
    await pump.stop();
    await pump.stop();
    expect(pump.disabled).toBe(true);
  });

  it("a success resets the consecutive-error count", async () => {
    let n = 0;
    const session: MockSession = {
      send: async () => {
        n++;
        // fail, succeed, fail, succeed, ...: never two consecutive failures
        if (n % 2 === 1) throw new Error("flaky");
        await sleep(1);
        return {};
      },
    };
    const pump = createFramePump(
      { cdp: session },
      { maxConsecutiveErrors: 2, backoffMs: 1 },
    );
    await sleep(40);
    await pump.stop();
    expect(pump.disabled).toBe(false);
  });
});
