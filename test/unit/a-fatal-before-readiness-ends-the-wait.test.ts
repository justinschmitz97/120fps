import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { Page } from "playwright";
import { attachPageErrorCapture, waitForReadyOrFatal } from "../../src/browser/index.js";

// taxonomy's shape: a module-eval throw lands before the readiness wait exists, so the capture
// already holds it and no later `pageerror` will ever arrive to end the race.
function makeFakePage(): { page: Page; emitter: EventEmitter } {
  const emitter = new EventEmitter();
  return { page: emitter as unknown as Page, emitter };
}

function neverResolves(): Promise<never> {
  return new Promise(() => {});
}

// Bounds the assertion itself, so a wait that never ends fails the test instead of hanging it.
async function settleWithin<T>(work: Promise<T>, ms: number): Promise<T | "still waiting"> {
  return await Promise.race([
    work,
    new Promise<"still waiting">((resolve) => {
      setTimeout(() => resolve("still waiting"), ms);
    }),
  ]);
}

function messageOf(work: Promise<unknown>): Promise<string | "still waiting"> {
  return settleWithin(
    work.then(
      () => "the readiness wait resolved unexpectedly",
      (err: Error) => err.message,
    ),
    300,
  );
}

describe("a fatal the capture already holds when the readiness wait starts", () => {
  it("ends the wait at once instead of after the bound", async () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("pageerror", new Error("Invalid environment variables"));

    const message = await messageOf(
      waitForReadyOrFatal(neverResolves, capture, "component harness"),
    );

    expect(message).toContain("component harness failed before it became ready");
    expect(message).toContain("Invalid environment variables");
  });

  it("names the throwing module the same way a fatal arriving later does", async () => {
    const stack = "Error: Invalid environment variables\n    at eval (http://localhost:5177/.h/src/env.mjs:12:34)";
    const before = makeFakePage();
    const beforeCapture = attachPageErrorCapture(before.page);
    const early = new Error("Invalid environment variables");
    early.stack = stack;
    before.emitter.emit("pageerror", early);
    const preRegistered = await messageOf(
      waitForReadyOrFatal(neverResolves, beforeCapture, "component harness"),
    );

    const after = makeFakePage();
    const afterCapture = attachPageErrorCapture(after.page);
    const pending = waitForReadyOrFatal(neverResolves, afterCapture, "component harness");
    const late = new Error("Invalid environment variables");
    late.stack = stack;
    after.emitter.emit("pageerror", late);
    const postRegistered = await messageOf(pending);

    expect(preRegistered).toContain("env.mjs: Invalid environment variables");
    expect(preRegistered).toBe(postRegistered);
  });

  it("appends the env remedy the lazy callback supplies, as the later path does", async () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("pageerror", new Error("process.env.API_URL is required"));

    const message = await messageOf(
      waitForReadyOrFatal(
        neverResolves,
        capture,
        "component harness",
        () => "No .env or .env.local found next to this component's project.",
      ),
    );

    expect(message).toContain("No .env or .env.local found next to this component's project.");
  });

  it("still waits when the capture holds no fatal", async () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("console", {
      type: () => "error",
      text: () => "a dev warning",
      args: () => [{ toString: () => "a dev warning" }],
    });

    const outcome = await messageOf(waitForReadyOrFatal(neverResolves, capture, "component harness"));

    expect(outcome).toBe("still waiting");
  });

  it("still resolves when readiness wins and nothing threw", async () => {
    const { page } = makeFakePage();
    const capture = attachPageErrorCapture(page);

    await expect(
      waitForReadyOrFatal(() => Promise.resolve(), capture, "component harness"),
    ).resolves.toBeUndefined();
  });
});
