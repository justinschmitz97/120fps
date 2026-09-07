import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { Page } from "playwright";
import { attachPageErrorCapture, waitForReadyOrFatal } from "../../src/browser/index.js";

// directus/twenty's shape: the dev server answers a module request with 500 in the first seconds,
// the module graph can never evaluate, and today the run waits out the whole readiness bound.
const HARNESS_DIR = ".120fps-harness-KAGFHv";
const ORIGIN = "http://localhost:5174";
const DOCUMENT = `${ORIGIN}/${HARNESS_DIR}/`;
const GRACE_MS = 10;

function makeFakePage(): { page: Page; emitter: EventEmitter } {
  const emitter = new EventEmitter();
  return { page: emitter as unknown as Page, emitter };
}

function makeResponse(status: number, method: string, url: string) {
  return {
    status: () => status,
    url: () => url,
    request: () => ({ method: () => method, url: () => url }),
  };
}

function neverResolves(): Promise<never> {
  return new Promise(() => {});
}

interface Harness {
  emitter: EventEmitter;
  capture: ReturnType<typeof attachPageErrorCapture>;
}

// Every run navigates to the harness document first, which is where the origin comes from.
function openedHarness(graceMs = GRACE_MS): Harness {
  const { page, emitter } = makeFakePage();
  const capture = attachPageErrorCapture(page, HARNESS_DIR, { moduleErrorGraceMs: graceMs });
  emitter.emit("response", makeResponse(200, "GET", DOCUMENT));
  return { emitter, capture };
}

async function outcomeOf(work: Promise<unknown>, ms = 200): Promise<string> {
  return await Promise.race([
    work.then(
      () => "ready",
      (err: Error) => err.message,
    ),
    new Promise<string>((resolve) => {
      setTimeout(() => resolve("still waiting"), ms);
    }),
  ]);
}

describe("a module request the dev server answers with a server error", () => {
  it("ends the readiness wait, naming the url, the status and what cannot evaluate", async () => {
    const { emitter, capture } = openedHarness();
    const url = `${ORIGIN}/@fs/E:/directus/packages/system-data/src/fields/fields.yaml?import`;
    const pending = waitForReadyOrFatal(neverResolves, capture, "component harness");
    emitter.emit("response", makeResponse(500, "GET", url));

    const message = await outcomeOf(pending);

    expect(message).toContain(url);
    expect(message).toContain("500");
    expect(message).toContain("module graph");
  });

  it("ends the wait for a module extension the harness serves, with no ?import query", async () => {
    const { emitter, capture } = openedHarness();
    const url = `${ORIGIN}/@fs/E:/app/src/components/Banner.vue`;
    const pending = waitForReadyOrFatal(neverResolves, capture, "component harness");
    emitter.emit("response", makeResponse(500, "GET", url));

    expect(await outcomeOf(pending)).toContain("Banner.vue");
  });

  it("keeps the response line in the page-error block it already recorded", async () => {
    const { emitter, capture } = openedHarness();
    const url = `${ORIGIN}/src/main.ts?import`;
    const pending = waitForReadyOrFatal(neverResolves, capture, "component harness");
    emitter.emit("response", makeResponse(503, "GET", url));

    expect(await outcomeOf(pending)).toContain(`response 503: GET ${url}`);
  });
});

describe("a response error that is not a failed module transform", () => {
  it.each([
    [404, "a missing optional chunk"],
    [302, "a redirect"],
    [499, "a client-side abort"],
  ])("does not end the wait on %i (%s)", async (status) => {
    const { emitter, capture } = openedHarness();
    const pending = waitForReadyOrFatal(neverResolves, capture, "component harness");
    emitter.emit("response", makeResponse(status, "GET", `${ORIGIN}/src/main.ts?import`));

    expect(await outcomeOf(pending)).toBe("still waiting");
  });

  it("does not end the wait on a cross-origin 500", async () => {
    const { emitter, capture } = openedHarness();
    const pending = waitForReadyOrFatal(neverResolves, capture, "component harness");
    emitter.emit("response", makeResponse(500, "GET", "https://cdn.example.com/analytics.js"));

    expect(await outcomeOf(pending)).toBe("still waiting");
  });

  it("does not end the wait on a 500 for a url that is not requested as a module", async () => {
    const { emitter, capture } = openedHarness();
    const pending = waitForReadyOrFatal(neverResolves, capture, "component harness");
    emitter.emit("response", makeResponse(500, "GET", `${ORIGIN}/api/session.json`));

    expect(await outcomeOf(pending)).toBe("still waiting");
  });

  it("does not end the wait on the harness's own placeholder traffic", async () => {
    const { emitter, capture } = openedHarness();
    const pending = waitForReadyOrFatal(neverResolves, capture, "component harness");
    emitter.emit("response", makeResponse(500, "GET", `${ORIGIN}/${HARNESS_DIR}/placeholder?import`));

    expect(await outcomeOf(pending)).toBe("still waiting");
  });
});

describe("a module error that a readiness resolution overtakes", () => {
  it("loses the race: the wait resolves and the run continues", async () => {
    const { emitter, capture } = openedHarness(150);
    emitter.emit("response", makeResponse(500, "GET", `${ORIGIN}/src/optional.ts?import`));

    await expect(
      waitForReadyOrFatal(() => Promise.resolve(), capture, "component harness"),
    ).resolves.toBeUndefined();
  });

  it("leaves no armed fatal behind for the next wait on the same page", async () => {
    const { emitter, capture } = openedHarness(150);
    emitter.emit("response", makeResponse(500, "GET", `${ORIGIN}/src/optional.ts?import`));
    await waitForReadyOrFatal(() => Promise.resolve(), capture, "component harness");

    const second = waitForReadyOrFatal(neverResolves, capture, "component harness");

    expect(await outcomeOf(second, 250)).toBe("still waiting");
  });
});
