import { describe, it, expect } from "vitest";
import { createBrowserPool, MEASUREMENT_BROWSER_ARGS } from "../../src/measure.js";

interface FakeBrowser {
  closed: boolean;
  close(): Promise<void>;
}

function fakeLauncher() {
  const launches: string[][] = [];
  const browsers: FakeBrowser[] = [];
  const launcher = async (args: string[]) => {
    launches.push(args);
    const b: FakeBrowser = {
      closed: false,
      close: async () => {
        b.closed = true;
      },
    };
    browsers.push(b);
    return b as never;
  };
  return { launcher, launches, browsers };
}

describe("M37: createBrowserPool", () => {
  it("launches lazily and caches per kind", async () => {
    const { launcher, launches } = fakeLauncher();
    const pool = createBrowserPool(launcher as never);
    expect(launches).toHaveLength(0);

    const a = await pool.acquire(true);
    const b = await pool.acquire(true);
    expect(a).toBe(b);
    expect(launches).toHaveLength(1);
    expect(launches[0]).toEqual(MEASUREMENT_BROWSER_ARGS);

    await pool.acquire(false);
    expect(launches).toHaveLength(2);
    expect(launches[1]).toEqual([]);
    expect(pool.stats().launched).toBe(2);
  });

  it("closeAll closes both browsers and poisons acquire", async () => {
    const { launcher, browsers } = fakeLauncher();
    const pool = createBrowserPool(launcher as never);
    await pool.acquire(true);
    await pool.acquire(false);
    await pool.closeAll();
    expect(browsers.every((b) => b.closed)).toBe(true);
    await expect(pool.acquire(true)).rejects.toThrow(/closed/);
  });

  it("closeAll on an unused pool is a no-op", async () => {
    const { launcher, launches } = fakeLauncher();
    const pool = createBrowserPool(launcher as never);
    await pool.closeAll();
    expect(launches).toHaveLength(0);
    expect(pool.stats().launched).toBe(0);
  });
});
