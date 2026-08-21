import { describe, it, expect, vi, afterEach } from "vitest";
import { armExitWatchdog, closePoolsBounded } from "../../src/cli.js";
import { closeServerBounded } from "../../src/harness.js";

// M88: the taxonomy hang -- a fatal error printed, then the process stayed
// alive until an external timeout killed it. Pool/server teardown that never
// settles (the known "vitest-only dev-server teardown after transformRequest"
// shape) must never block the process from exiting with its documented code.

describe("armExitWatchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("calls process.exit with the given code after the timeout elapses", () => {
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    armExitWatchdog(2, 1000);
    expect(exitSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("does not fire once cleared", () => {
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const timer = armExitWatchdog(1, 1000);
    clearTimeout(timer);
    vi.advanceTimersByTime(2000);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("closePoolsBounded", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("settles once both pools close normally, without invoking process.exit itself", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const pool = { closeAll: vi.fn().mockResolvedValue(undefined) };
    const serverPool = { closeAll: vi.fn().mockResolvedValue(undefined) };
    await closePoolsBounded(pool as never, serverPool as never, 5000);
    expect(pool.closeAll).toHaveBeenCalled();
    expect(serverPool.closeAll).toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("still settles within the bound when a pool's closeAll never resolves", async () => {
    const pool = { closeAll: () => new Promise<void>(() => {}) };
    const serverPool = { closeAll: vi.fn().mockResolvedValue(undefined) };
    const start = Date.now();
    await closePoolsBounded(pool as never, serverPool as never, 50);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("does not let one pool's throw prevent the other from being awaited", async () => {
    const pool = { closeAll: vi.fn().mockRejectedValue(new Error("boom")) };
    const serverPool = { closeAll: vi.fn().mockResolvedValue(undefined) };
    await closePoolsBounded(pool as never, serverPool as never, 5000);
    expect(serverPool.closeAll).toHaveBeenCalled();
  });
});

describe("closeServerBounded (src/harness.ts)", () => {
  it("settles within the bound when server.close() never resolves", async () => {
    const server = { close: () => new Promise<void>(() => {}) };
    const start = Date.now();
    await closeServerBounded(server as never, 50);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("settles once close() resolves normally", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const server = { close };
    await closeServerBounded(server as never, 5000);
    expect(close).toHaveBeenCalled();
  });

  it("does not throw when close() rejects", async () => {
    const server = { close: vi.fn().mockRejectedValue(new Error("already closed")) };
    await expect(closeServerBounded(server as never, 5000)).resolves.toBeUndefined();
  });
});
