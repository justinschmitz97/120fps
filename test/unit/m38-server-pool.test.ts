import { describe, it, expect } from "vitest";
import { createServerPool, SWEEP_DEP_WARNING } from "../../src/harness.js";

interface FakeServer {
  closed: boolean;
  close(): Promise<void>;
}

function fakeBoot() {
  const servers: FakeServer[] = [];
  const boot = async () => {
    const s: FakeServer = {
      closed: false,
      close: async () => {
        s.closed = true;
      },
    };
    servers.push(s);
    return s as never;
  };
  return { boot, servers };
}

describe("M38: createServerPool", () => {
  it("boots once per key and caches", async () => {
    const { boot, servers } = fakeBoot();
    const pool = createServerPool();
    const a = await pool.acquire("key-1", boot, ["react", "clsx"]);
    const b = await pool.acquire("key-1", boot, ["react"]);
    expect(a.server).toBe(b.server);
    expect(a.reused).toBe(false);
    expect(b.reused).toBe(true);
    expect(servers).toHaveLength(1);
    expect(pool.stats().booted).toBe(1);
  });

  it("keeps the include snapshot from the first boot", async () => {
    const { boot } = fakeBoot();
    const pool = createServerPool();
    await pool.acquire("key-1", boot, ["react", "clsx"]);
    const second = await pool.acquire("key-1", boot, ["react", "date-fns"]);
    expect(second.include.has("clsx")).toBe(true);
    expect(second.include.has("date-fns")).toBe(false);
  });

  it("boots separately per key", async () => {
    const { boot, servers } = fakeBoot();
    const pool = createServerPool();
    const a = await pool.acquire("key-1", boot, []);
    const b = await pool.acquire("key-2", boot, []);
    expect(a.server).not.toBe(b.server);
    expect(servers).toHaveLength(2);
    expect(pool.stats().booted).toBe(2);
  });

  it("closeAll closes every server and poisons acquire", async () => {
    const { boot, servers } = fakeBoot();
    const pool = createServerPool();
    await pool.acquire("key-1", boot, []);
    await pool.acquire("key-2", boot, []);
    await pool.closeAll();
    expect(servers.every((s) => s.closed)).toBe(true);
    await expect(pool.acquire("key-1", boot, [])).rejects.toThrow(/closed/);
  });
});

describe("M38: SWEEP_DEP_WARNING", () => {
  it("names the missing dependencies", () => {
    const w = SWEEP_DEP_WARNING(["date-fns", "clsx"]);
    expect(w).toContain("date-fns");
    expect(w).toContain("clsx");
  });
});
