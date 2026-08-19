import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { Page } from "playwright";
import {
  attachPageErrorCapture,
  enrichTimeoutError,
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
