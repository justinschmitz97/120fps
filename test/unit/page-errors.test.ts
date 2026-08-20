import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { Page } from "playwright";
import {
  attachPageErrorCapture,
  enrichTimeoutError,
  isHarnessInternalNoise,
  extractThrowingModule,
  waitForReadyOrFatal,
  type PageErrorCapture,
} from "../../src/page-errors.js";

// --- helpers ---

function makeFakePage(): { page: Page; emitter: EventEmitter } {
  const emitter = new EventEmitter();
  return { page: emitter as unknown as Page, emitter };
}

function makeConsoleMessage(type: string, text: string) {
  return { type: () => type, text: () => text };
}

function makeTimeoutError(message = "Timeout 30000ms exceeded."): Error {
  const err = new Error(message);
  err.name = "TimeoutError";
  return err;
}

function makeFailedRequest(method: string, url: string, errorText: string | null = "net::ERR_ABORTED") {
  return {
    method: () => method,
    url: () => url,
    failure: () => (errorText === null ? null : { errorText }),
  };
}

function makeResponse(status: number, method: string, url: string) {
  return {
    status: () => status,
    url: () => url,
    request: () => ({ method: () => method, url: () => url }),
  };
}

// ====================================================================
// attachPageErrorCapture
// ====================================================================

describe("attachPageErrorCapture", () => {
  it("records pageerror messages", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("pageerror", new Error("boom"));
    expect(capture.errors).toEqual(["boom"]);
  });

  it("records console messages of type error", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("console", makeConsoleMessage("error", "console boom"));
    expect(capture.errors).toEqual(["console boom"]);
  });

  it("ignores console messages of other types", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("console", makeConsoleMessage("log", "hello"));
    emitter.emit("console", makeConsoleMessage("warning", "careful"));
    emitter.emit("console", makeConsoleMessage("info", "fyi"));
    expect(capture.errors).toEqual([]);
  });

  it("interleaves pageerror and console error in arrival order", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("pageerror", new Error("first"));
    emitter.emit("console", makeConsoleMessage("error", "second"));
    emitter.emit("pageerror", new Error("third"));
    expect(capture.errors).toEqual(["first", "second", "third"]);
  });

  it("caps buffer at 20 entries and counts the rest", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    for (let i = 0; i < 25; i++) {
      emitter.emit("pageerror", new Error(`err ${i}`));
    }
    expect(capture.errors).toHaveLength(20);
    expect(capture.errors[0]).toBe("err 0");
    expect(capture.errors[19]).toBe("err 19");
    expect(capture.summary()).toContain("5 more");
  });

  it("summary lists each captured error", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("pageerror", new Error("alpha"));
    emitter.emit("console", makeConsoleMessage("error", "beta"));
    const summary = capture.summary();
    expect(summary).toContain("alpha");
    expect(summary).toContain("beta");
  });

  it("summary omits drop count when under the cap", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("pageerror", new Error("only"));
    expect(capture.summary()).not.toContain("more");
  });

  it("two captures on the same page record independently", () => {
    const { page, emitter } = makeFakePage();
    const first = attachPageErrorCapture(page);
    const second = attachPageErrorCapture(page);
    emitter.emit("pageerror", new Error("shared"));
    expect(first.errors).toEqual(["shared"]);
    expect(second.errors).toEqual(["shared"]);
    for (let i = 0; i < 30; i++) emitter.emit("pageerror", new Error(`x${i}`));
    expect(first.errors).toHaveLength(20);
    expect(second.errors).toHaveLength(20);
  });

  it("summary preserves multiline error messages", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("pageerror", new Error("line one\n    at Component (app.tsx:5:3)"));
    const summary = capture.summary();
    expect(summary).toContain("line one");
    expect(summary).toContain("at Component (app.tsx:5:3)");
  });

  it("errors array is live: events after first read are visible", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("pageerror", new Error("early"));
    expect(capture.errors).toHaveLength(1);
    emitter.emit("pageerror", new Error("late"));
    expect(capture.errors).toHaveLength(2);
    expect(capture.summary()).toContain("late");
  });

  it("collapses repeated identical messages into one entry with a repeat count", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    for (let i = 0; i < 25; i++) {
      emitter.emit("pageerror", new Error("noisy"));
    }
    emitter.emit("pageerror", new Error("the real error"));
    expect(capture.errors).toEqual(["noisy (×25)", "the real error"]);
    expect(capture.summary()).not.toContain("dropped");
  });

  it("caps retention at 20 DISTINCT messages, not 20 raw events", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    for (let i = 0; i < 20; i++) {
      emitter.emit("pageerror", new Error(`distinct ${i}`));
    }
    // 40 repeats of one already-seen message must not evict any distinct entry.
    for (let i = 0; i < 40; i++) {
      emitter.emit("pageerror", new Error("distinct 0"));
    }
    expect(capture.errors).toHaveLength(20);
    expect(capture.errors[0]).toBe("distinct 0 (×41)");
    expect(capture.errors[19]).toBe("distinct 19");
  });

  it("drops a new distinct message once 20 distinct messages are already buffered", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    for (let i = 0; i < 20; i++) {
      emitter.emit("pageerror", new Error(`distinct ${i}`));
    }
    emitter.emit("pageerror", new Error("21st distinct"));
    expect(capture.errors).toHaveLength(20);
    expect(capture.summary()).toContain("1 more dropped");
  });

  it("does not report a dropped-notice at exactly 20 distinct messages", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    for (let i = 0; i < 20; i++) {
      emitter.emit("pageerror", new Error(`distinct ${i}`));
    }
    expect(capture.summary()).not.toContain("dropped");
  });
});

// ====================================================================
// network failure capture
// ====================================================================

describe("attachPageErrorCapture: network failures", () => {
  it("records a failed request with its method, url and error text", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("requestfailed", makeFailedRequest("GET", "http://localhost/app.css", "net::ERR_ABORTED"));
    expect(capture.errors).toEqual([
      "request failed: GET http://localhost/app.css (net::ERR_ABORTED)",
    ]);
  });

  it("records a failed request with no failure text without a trailing paren", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("requestfailed", makeFailedRequest("GET", "http://localhost/app.css", null));
    expect(capture.errors).toEqual(["request failed: GET http://localhost/app.css"]);
  });

  it("records a 404 response with its status, method and url", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("response", makeResponse(404, "GET", "http://localhost/missing.css"));
    expect(capture.errors).toEqual(["response 404: GET http://localhost/missing.css"]);
  });

  it("records a 500 response", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("response", makeResponse(500, "GET", "http://localhost/preprocess.css"));
    expect(capture.errors).toEqual(["response 500: GET http://localhost/preprocess.css"]);
  });

  it("ignores successful and redirect responses", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("response", makeResponse(200, "GET", "http://localhost/ok.css"));
    emitter.emit("response", makeResponse(304, "GET", "http://localhost/cached.css"));
    emitter.emit("response", makeResponse(302, "GET", "http://localhost/redirect.css"));
    expect(capture.errors).toEqual([]);
  });

  it("does not mark the drain fatal for network failures alone", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("requestfailed", makeFailedRequest("GET", "http://localhost/app.css"));
    emitter.emit("response", makeResponse(404, "GET", "http://localhost/missing.css"));
    expect(capture.drain().fatal).toBe(false);
  });

  it("still marks fatal when a pageerror arrives alongside network failures", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("response", makeResponse(404, "GET", "http://localhost/missing.css"));
    emitter.emit("pageerror", new Error("boom"));
    expect(capture.drain().fatal).toBe(true);
  });

  it("dedupes repeated identical network failures with a repeat count", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    for (let i = 0; i < 3; i++) {
      emitter.emit("response", makeResponse(404, "GET", "http://localhost/missing.css"));
    }
    expect(capture.errors).toEqual(["response 404: GET http://localhost/missing.css (×3)"]);
  });

  it("shares the same 20-distinct cap with pageerror and console messages", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    for (let i = 0; i < 15; i++) {
      emitter.emit("pageerror", new Error(`distinct ${i}`));
    }
    for (let i = 0; i < 10; i++) {
      emitter.emit("response", makeResponse(404, "GET", `http://localhost/missing-${i}.css`));
    }
    expect(capture.errors).toHaveLength(20);
    expect(capture.summary()).toContain("5 more");
  });

  it("participates in drain()/segment reset like console errors", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("response", makeResponse(404, "GET", "http://localhost/missing.css"));
    const first = capture.drain();
    expect(first.messages).toEqual(["response 404: GET http://localhost/missing.css"]);
    const second = capture.drain();
    expect(second.messages).toEqual([]);
    // The session bucket (used by `errors`/`summary`) is unaffected by drain().
    expect(capture.errors).toEqual(["response 404: GET http://localhost/missing.css"]);
  });
});

// ====================================================================
// M83 #2 (element-plus-F3): the harness must not blame the component for
// its own noise. A synthesized string placeholder ("test") landing in an
// <img src> relative-resolves against the harness's own serving root and
// 404s; that 404 is caused by the harness's own synthesis, not the
// component, and must not reach per-combo attribution.
// ====================================================================

describe("isHarnessInternalNoise", () => {
  it("is true for a bare, extension-less direct child of the harness root", () => {
    expect(
      isHarnessInternalNoise("http://localhost:5177/.120fps-harness-KAGFHv/test", ".120fps-harness-KAGFHv"),
    ).toBe(true);
  });

  it("is false when the final segment carries a file extension (a real asset 404)", () => {
    expect(
      isHarnessInternalNoise("http://localhost:5177/.120fps-harness-KAGFHv/app.css", ".120fps-harness-KAGFHv"),
    ).toBe(false);
  });

  it("is false when the request has a subdirectory prefix", () => {
    expect(
      isHarnessInternalNoise("http://localhost:5177/.120fps-harness-KAGFHv/src/test", ".120fps-harness-KAGFHv"),
    ).toBe(false);
    expect(
      isHarnessInternalNoise("http://localhost:5177/.120fps-harness-KAGFHv/@fs/test", ".120fps-harness-KAGFHv"),
    ).toBe(false);
  });

  it("is false for a path under a different harness directory", () => {
    expect(
      isHarnessInternalNoise("http://localhost:5177/.120fps-harness-other/test", ".120fps-harness-KAGFHv"),
    ).toBe(false);
  });

  it("is false for a request outside the harness root entirely", () => {
    expect(isHarnessInternalNoise("http://localhost:5177/test", ".120fps-harness-KAGFHv")).toBe(false);
  });

  it("is false for an unparseable url", () => {
    expect(isHarnessInternalNoise("not a url", ".120fps-harness-KAGFHv")).toBe(false);
  });
});

describe("attachPageErrorCapture: harness-internal noise attribution", () => {
  it("excludes a bare extension-less 404 under the harness root when harnessDirName is given", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page, ".120fps-harness-KAGFHv");
    emitter.emit("response", makeResponse(404, "GET", "http://localhost:5177/.120fps-harness-KAGFHv/test"));
    expect(capture.errors).toEqual([]);
  });

  it("excludes the same shape from requestfailed too", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page, ".120fps-harness-KAGFHv");
    emitter.emit(
      "requestfailed",
      makeFailedRequest("GET", "http://localhost:5177/.120fps-harness-KAGFHv/test"),
    );
    expect(capture.errors).toEqual([]);
  });

  it("still surfaces a genuine CSS 404 under the same harness root (M70 unaffected)", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page, ".120fps-harness-KAGFHv");
    emitter.emit(
      "response",
      makeResponse(404, "GET", "http://localhost:5177/.120fps-harness-KAGFHv/app.css"),
    );
    expect(capture.errors).toEqual([
      "response 404: GET http://localhost:5177/.120fps-harness-KAGFHv/app.css",
    ]);
  });

  it("does not exclude anything when harnessDirName is omitted (backward compatible)", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("response", makeResponse(404, "GET", "http://localhost:5177/.120fps-harness-KAGFHv/test"));
    expect(capture.errors).toEqual([
      "response 404: GET http://localhost:5177/.120fps-harness-KAGFHv/test",
    ]);
  });

  it("never marks the drain fatal for excluded noise", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page, ".120fps-harness-KAGFHv");
    emitter.emit("response", makeResponse(404, "GET", "http://localhost:5177/.120fps-harness-KAGFHv/test"));
    expect(capture.drain().fatal).toBe(false);
  });
});

// ====================================================================
// enrichTimeoutError
// ====================================================================

describe("enrichTimeoutError", () => {
  function makeCaptureWith(errors: string[]): PageErrorCapture {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    for (const e of errors) emitter.emit("pageerror", new Error(e));
    return capture;
  }

  it("names the 404'd url when a timeout is enriched after a failed css request", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("response", makeResponse(404, "GET", "http://localhost/app.css"));
    const result = enrichTimeoutError(makeTimeoutError(), capture, "component harness");
    expect(result.message).toContain("response 404: GET http://localhost/app.css");
  });

  it("enriches a TimeoutError with context and captured page errors", () => {
    const capture = makeCaptureWith(["component threw at import"]);
    const result = enrichTimeoutError(makeTimeoutError(), capture, "mount harness");
    expect(result.message).toContain("mount harness did not become ready within timeout.");
    expect(result.message).toContain("Page errors:");
    expect(result.message).toContain("component threw at import");
  });

  it("sets the original error as cause", () => {
    const original = makeTimeoutError();
    const capture = makeCaptureWith(["x"]);
    const result = enrichTimeoutError(original, capture, "mount harness");
    expect(result.cause).toBe(original);
  });

  it("notes when no page errors were captured", () => {
    const capture = makeCaptureWith([]);
    const result = enrichTimeoutError(makeTimeoutError(), capture, "explorer harness");
    expect(result.message).toContain("explorer harness did not become ready within timeout.");
    expect(result.message).toContain("No page errors were captured.");
    expect(result.message).not.toContain("Page errors:");
  });

  it("treats an error whose message includes 'Timeout' as a timeout", () => {
    const err = new Error("page.waitForFunction: Timeout 5000ms exceeded");
    const capture = makeCaptureWith(["boom"]);
    const result = enrichTimeoutError(err, capture, "react analysis harness");
    expect(result.message).toContain("react analysis harness did not become ready within timeout.");
    expect(result.message).toContain("boom");
  });

  it("returns non-timeout Errors unchanged (same reference)", () => {
    const err = new Error("connection refused");
    const capture = makeCaptureWith(["boom"]);
    const result = enrichTimeoutError(err, capture, "mount harness");
    expect(result).toBe(err);
  });

  it("wraps non-Error non-timeout values as Error", () => {
    const capture = makeCaptureWith([]);
    const result = enrichTimeoutError("something broke", capture, "mount harness");
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toContain("something broke");
  });

  it("wraps and enriches a non-Error value whose text includes 'Timeout'", () => {
    const capture = makeCaptureWith(["late script error"]);
    const result = enrichTimeoutError("Timeout exceeded", capture, "mount harness");
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toContain("mount harness did not become ready within timeout.");
    expect(result.message).toContain("late script error");
  });

  it("does not treat lowercase 'timeout' as a timeout", () => {
    const err = new Error("socket timeout while connecting");
    const capture = makeCaptureWith(["boom"]);
    const result = enrichTimeoutError(err, capture, "mount harness");
    expect(result).toBe(err);
  });
});

// ====================================================================
// M79 gap 3b (taxonomy-F1): a synchronous throw during module evaluation
// (e.g. next.config.mjs's env-validation) fires page.on("pageerror") almost
// immediately, but nothing used to race that against the 30s readiness gate:
// the run waited out the full timeout before ever reading what the capture
// already had within the first second. waitForFatal/waitForReadyOrFatal make
// the fatal signal preemptive instead of merely diagnostic-after-the-fact.
// ====================================================================

describe("PageErrorCapture.waitForFatal", () => {
  it("resolves with the message and stack when a pageerror fires", async () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    const pending = capture.waitForFatal();
    const err = new Error("createEnv failed: NEXT_PUBLIC_API_URL is required");
    err.stack = "Error: createEnv failed\n    at eval (http://localhost:5177/.h/src/env.mjs:12:34)";
    emitter.emit("pageerror", err);
    const fatal = await pending;
    expect(fatal.message).toBe("createEnv failed: NEXT_PUBLIC_API_URL is required");
    expect(fatal.stack).toContain("env.mjs");
  });

  it("never resolves from console.error or a network failure (fatal means an uncaught exception)", async () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    let resolved = false;
    capture.waitForFatal().then(() => { resolved = true; });
    emitter.emit("console", makeConsoleMessage("error", "just a dev warning"));
    emitter.emit("response", makeResponse(404, "GET", "http://localhost/app.css"));
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it("a fresh call after the first fatal only resolves on the NEXT pageerror", async () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("pageerror", new Error("first"));
    let secondResolved = false;
    capture.waitForFatal().then(() => { secondResolved = true; });
    await Promise.resolve();
    expect(secondResolved).toBe(false);
    emitter.emit("pageerror", new Error("second"));
    await Promise.resolve();
    expect(secondResolved).toBe(true);
  });

  it("still records the fatal message into the normal bucket (session/segment unaffected)", async () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    capture.waitForFatal();
    emitter.emit("pageerror", new Error("boom"));
    expect(capture.errors).toEqual(["boom"]);
  });
});

describe("extractThrowingModule", () => {
  it("names the first source-file frame with a JS/TS extension", () => {
    const stack =
      "Error: createEnv failed\n" +
      "    at eval (http://localhost:5177/.120fps-harness-x/src/env.mjs:12:34)\n" +
      "    at http://localhost:5177/.120fps-harness-x/next.config.mjs:3:1";
    expect(extractThrowingModule(stack)).toBe("env.mjs");
  });

  it("recognizes .ts/.tsx/.js/.jsx/.vue frames", () => {
    expect(extractThrowingModule("Error: x\n  at http://h/src/App.tsx:1:1")).toBe("App.tsx");
    expect(extractThrowingModule("Error: x\n  at http://h/src/store.ts:1:1")).toBe("store.ts");
    expect(extractThrowingModule("Error: x\n  at http://h/src/util.js:1:1")).toBe("util.js");
    expect(extractThrowingModule("Error: x\n  at http://h/src/Widget.jsx:1:1")).toBe("Widget.jsx");
    expect(extractThrowingModule("Error: x\n  at http://h/src/Widget.vue:1:1")).toBe("Widget.vue");
  });

  it("returns undefined for a stack with no recognizable source frame", () => {
    expect(extractThrowingModule("Error: boom\n    at <anonymous>")).toBeUndefined();
  });

  it("returns undefined when no stack is given at all", () => {
    expect(extractThrowingModule(undefined)).toBeUndefined();
  });

  it("skips the message line and reads only frame lines", () => {
    const stack = "Error: failed in App.mjs somehow\n    at http://h/src/real.ts:9:1";
    expect(extractThrowingModule(stack)).toBe("real.ts");
  });
});

describe("waitForReadyOrFatal", () => {
  function neverResolves(): Promise<never> {
    return new Promise(() => {});
  }

  it("resolves normally when readiness wins the race", async () => {
    const { page } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    await expect(
      waitForReadyOrFatal(() => Promise.resolve(), capture, "component harness"),
    ).resolves.toBeUndefined();
  });

  it("throws fast, naming the page error, when a fatal signal wins before readiness settles", async () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    const pending = waitForReadyOrFatal(neverResolves, capture, "component harness");
    const err = new Error("createEnv failed: NEXT_PUBLIC_API_URL is required");
    emitter.emit("pageerror", err);
    await expect(pending).rejects.toThrow(/createEnv failed/);
  });

  it("does not lead with 'did not become ready within timeout' on the fail-fast path", async () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    const pending = waitForReadyOrFatal(neverResolves, capture, "component harness");
    emitter.emit("pageerror", new Error("createEnv failed"));
    let message = "";
    try {
      await pending;
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toMatch(/did not become ready within timeout/);
    expect(message).toMatch(/createEnv failed/);
  });

  it("names the throwing module when the stack yields one", async () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    const pending = waitForReadyOrFatal(neverResolves, capture, "component harness");
    const err = new Error("createEnv failed");
    err.stack = "Error: createEnv failed\n    at eval (http://localhost:5177/.h/src/env.mjs:3:1)";
    emitter.emit("pageerror", err);
    await expect(pending).rejects.toThrow(/env\.mjs/);
  });

  it("falls back to the page-error text alone when the stack yields no module name", async () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    const pending = waitForReadyOrFatal(neverResolves, capture, "component harness");
    const err = new Error("createEnv failed");
    err.stack = "Error: createEnv failed\n    at <anonymous>";
    emitter.emit("pageerror", err);
    await expect(pending).rejects.toThrow(/createEnv failed/);
  });

  it("falls back to enrichTimeoutError's shape when readiness times out with no fatal signal", async () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("response", makeResponse(404, "GET", "http://localhost/app.css"));
    const pending = waitForReadyOrFatal(
      () => Promise.reject(makeTimeoutError()),
      capture,
      "component harness",
    );
    let message = "";
    try {
      await pending;
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("component harness did not become ready within timeout.");
    expect(message).toContain("response 404: GET http://localhost/app.css");
  });

  it("appends the env-remedy line only when the lazy callback supplies one", async () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    const pending = waitForReadyOrFatal(
      neverResolves,
      capture,
      "component harness",
      () => "No .env or .env.local found; only NEXT_PUBLIC_*/VITE_* keys reach the page.",
    );
    emitter.emit("pageerror", new Error("createEnv failed"));
    await expect(pending).rejects.toThrow(/NEXT_PUBLIC_/);
  });

  it("does not call the env-remedy callback on the healthy path", async () => {
    const { page } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    let called = false;
    await waitForReadyOrFatal(() => Promise.resolve(), capture, "component harness", () => {
      called = true;
      return undefined;
    });
    expect(called).toBe(false);
  });

  it("does not call the env-remedy callback on a plain timeout with no fatal", async () => {
    const { page } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    let called = false;
    try {
      await waitForReadyOrFatal(
        () => Promise.reject(makeTimeoutError()),
        capture,
        "component harness",
        () => {
          called = true;
          return undefined;
        },
      );
    } catch {
      // expected
    }
    expect(called).toBe(false);
  });
});
