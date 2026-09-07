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

// Every argument list, paren-balanced, so a nested harnessReadyTimeoutMs() does not end the slice.
function navigationCalls(text: string): string[] {
  const calls: string[] = [];
  for (let at = text.indexOf(CALL); at !== -1; at = text.indexOf(CALL, at + 1)) {
    let depth = 0;
    for (let i = at + CALL.length - 1; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) {
        calls.push(text.slice(at, i + 1));
        break;
      }
    }
  }
  return calls;
}

const CALL = "gotoWithErrorContext(";

function makeCapture() {
  const emitter = new EventEmitter();
  return attachPageErrorCapture(emitter as unknown as Page);
}

// The seam every navigation goes through: what the wrapper forwards is what Playwright receives.
function recordingPage(): {
  page: { goto(url: string, options?: Record<string, unknown>): Promise<unknown> };
  seen: Array<{ url: string; options?: Record<string, unknown> }>;
} {
  const seen: Array<{ url: string; options?: Record<string, unknown> }> = [];
  return {
    page: {
      goto: async (url: string, options?: Record<string, unknown>) => {
        seen.push({ url, options });
        return undefined;
      },
    },
    seen,
  };
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
  it.each(NAVIGATION_SITES)("passes an explicit readiness bound at every call site in %s", (relative) => {
    const calls = navigationCalls(source(relative));

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatch(/timeout: (harnessReadyTimeoutMs\(\)|readyTimeoutMs)/);
    }
  });

  it("forwards the options it was given to the page it navigates", async () => {
    const { page, seen } = recordingPage();

    await gotoWithErrorContext(page, "http://localhost:5173/.h/", makeCapture(), "component harness", {
      timeout: harnessReadyTimeoutMs(),
      waitUntil: "domcontentloaded",
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("http://localhost:5173/.h/");
    expect(seen[0].options).toEqual({
      timeout: harnessReadyTimeoutMs(),
      waitUntil: "domcontentloaded",
    });
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
