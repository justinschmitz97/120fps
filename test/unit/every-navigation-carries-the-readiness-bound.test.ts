import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { Page } from "playwright";
import {
  attachPageErrorCapture,
  gotoWithErrorContext,
  HARNESS_READY_TIMEOUT_ENV,
  harnessReadyTimeoutMs,
} from "../../src/browser/index.js";

// plane's shape: a navigation under load hit Playwright's own 30 s default and reported a bound
// nobody set, while the readiness wait it precedes was allowed 90 s.
const NAVIGATION_SITES = [
  "browser/session.ts",
  "pipeline/analyze.ts",
  "analysis/explorer.ts",
  "analysis/react-profiler.ts",
];

function source(relative: string): string {
  return fs.readFileSync(path.resolve("src", relative), "utf-8");
}

function makeCapture() {
  const emitter = new EventEmitter();
  return attachPageErrorCapture(emitter as unknown as Page);
}

function pageThatFailsToNavigate(err: Error) {
  return {
    goto: async (): Promise<never> => {
      throw err;
    },
  };
}

function timeoutError(): Error {
  const err = new Error("page.goto: Timeout 30000ms exceeded.");
  err.name = "TimeoutError";
  return err;
}

async function navigationFailure(options: Record<string, unknown>): Promise<string> {
  try {
    await gotoWithErrorContext(
      pageThatFailsToNavigate(timeoutError()),
      "http://localhost:5173/.120fps-harness-x/",
      makeCapture(),
      "component harness",
      options,
    );
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("the navigation resolved unexpectedly");
}

describe("every harness navigation", () => {
  it.each(NAVIGATION_SITES)("passes an explicit timeout at the call site in %s", (relative) => {
    const text = source(relative);
    const at = text.indexOf("gotoWithErrorContext(");
    expect(at).toBeGreaterThan(-1);
    expect(text.slice(at, at + 260)).toContain("timeout:");
  });

  it.each(NAVIGATION_SITES)("uses the readiness bound as that timeout in %s", (relative) => {
    const text = source(relative);
    const at = text.indexOf("gotoWithErrorContext(");
    const call = text.slice(at, at + 260);
    expect(call).toMatch(/timeout: (harnessReadyTimeoutMs\(\)|readyTimeoutMs)/);
  });
});

describe("a navigation that runs out its bound", () => {
  it("names the variable that raises the bound and the bound it used", async () => {
    const message = await navigationFailure({ timeout: 90000 });

    expect(message).toContain(HARNESS_READY_TIMEOUT_ENV);
    expect(message).toContain("90 s");
  });

  it("reads back the bound a raised FPS120_READY_TIMEOUT_MS would produce", async () => {
    const message = await navigationFailure({ timeout: 120000 });

    expect(message).toContain("120 s");
    expect(message).not.toContain("90 s");
  });

  it("stays distinguishable from the readiness wait's own note", async () => {
    const message = await navigationFailure({ timeout: harnessReadyTimeoutMs() });

    expect(message).toContain("component harness did not become ready within timeout.");
    expect(message).not.toContain("It waited");
  });

  it("leaves a non-timeout navigation error unchanged", async () => {
    const refused = new Error("net::ERR_CONNECTION_REFUSED");
    let thrown: unknown;
    try {
      await gotoWithErrorContext(
        pageThatFailsToNavigate(refused),
        "http://localhost:5173/.120fps-harness-x/",
        makeCapture(),
        "component harness",
        { timeout: 90000 },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBe(refused);
  });
});
