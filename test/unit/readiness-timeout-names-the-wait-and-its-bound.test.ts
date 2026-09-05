import { describe, it, expect, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Page } from "playwright";
import {
  attachPageErrorCapture,
  HARNESS_READY_TIMEOUT_ENV,
  waitForReadyOrFatal,
} from "../../src/browser/index.js";

function makeFakePage(): { page: Page; emitter: EventEmitter } {
  const emitter = new EventEmitter();
  return { page: emitter as unknown as Page, emitter };
}

function timeoutError(): Error {
  const err = new Error("Timeout 30000ms exceeded.");
  err.name = "TimeoutError";
  return err;
}

// Rejects like Playwright's own wait does: after its per-attempt bound, with a TimeoutError.
function attemptThatTimesOutAfter(ms: number): () => Promise<never> {
  return () =>
    new Promise((_, reject) => {
      setTimeout(() => reject(timeoutError()), ms);
    });
}

function counted<T>(attempt: () => Promise<T>): { run: () => Promise<T>; calls: () => number } {
  let calls = 0;
  return {
    run: () => {
      calls++;
      return attempt();
    },
    calls: () => calls,
  };
}

const savedBound = process.env[HARNESS_READY_TIMEOUT_ENV];

afterEach(() => {
  if (savedBound === undefined) delete process.env[HARNESS_READY_TIMEOUT_ENV];
  else process.env[HARNESS_READY_TIMEOUT_ENV] = savedBound;
});

async function failureOf(waitForReady: () => Promise<unknown>): Promise<string> {
  const { page } = makeFakePage();
  const capture = attachPageErrorCapture(page);
  try {
    await waitForReadyOrFatal(waitForReady, capture, "component harness");
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("the readiness wait resolved unexpectedly");
}

describe("a readiness timeout", () => {
  it("names the global it waited for, the time it waited and the way to wait longer", async () => {
    const message = await failureOf(attemptThatTimesOutAfter(5));

    expect(message).toContain("component harness did not become ready within timeout.");
    expect(message).toContain("window.__120fps");
    expect(message).toMatch(/waited [\d.]+ (ms|s)/);
    expect(message).toContain(HARNESS_READY_TIMEOUT_ENV);
  });

  it("keeps the page-error sentence it already carried", async () => {
    const message = await failureOf(attemptThatTimesOutAfter(5));

    expect(message).toContain("No page errors were captured.");
  });
});

describe("a wait whose own bound expires before the readiness deadline", () => {
  it("is entered again until it becomes ready", async () => {
    process.env[HARNESS_READY_TIMEOUT_ENV] = "5000";
    const { page } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    let calls = 0;
    const waitForReady = (): Promise<unknown> => {
      calls++;
      return calls === 1 ? attemptThatTimesOutAfter(150)() : Promise.resolve(true);
    };

    await waitForReadyOrFatal(waitForReady, capture, "component harness");

    expect(calls).toBe(2);
  });

  it("is entered again until the deadline has passed", async () => {
    process.env[HARNESS_READY_TIMEOUT_ENV] = "400";
    const attempt = counted(attemptThatTimesOutAfter(150));

    const message = await failureOf(attempt.run);

    expect(attempt.calls()).toBeGreaterThan(1);
    expect(message).toContain("did not become ready within timeout.");
  });

  it("still loses to a page error that arrives between two attempts", async () => {
    process.env[HARNESS_READY_TIMEOUT_ENV] = "5000";
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    let calls = 0;
    const waitForReady = (): Promise<unknown> => {
      calls++;
      if (calls === 2) emitter.emit("pageerror", new Error("Foo is not defined"));
      return attemptThatTimesOutAfter(150)();
    };

    let message = "";
    try {
      await waitForReadyOrFatal(waitForReady, capture, "component harness");
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("failed before it became ready");
    expect(message).toContain("Foo is not defined");
  });
});

describe("a wait that ends on its own", () => {
  it("is not entered again when it gave up before the retry floor", async () => {
    process.env[HARNESS_READY_TIMEOUT_ENV] = "5000";
    const attempt = counted(attemptThatTimesOutAfter(5));

    await failureOf(attempt.run);

    expect(attempt.calls()).toBe(1);
  });

  it("is entered once when the harness becomes ready", async () => {
    const { page } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    const attempt = counted(() => Promise.resolve(true));

    await waitForReadyOrFatal(attempt.run, capture, "component harness");

    expect(attempt.calls()).toBe(1);
  });
});
