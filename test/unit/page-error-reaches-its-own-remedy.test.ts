import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { Page } from "playwright";
import {
  attachPageErrorCapture,
  gotoWithErrorContext,
  waitForReadyOrFatal,
} from "../../src/page-errors.js";

// documenso-F1: a Babel macro throws during module evaluation, before
// `waitForReadyOrFatal` registers its waiter. The throw was dropped, the run
// reported "did not become ready within timeout", and appended an
// environment-file remedy to an error that never mentioned an environment
// variable ("Unable to determine current node version").
const ENV_REMEDY = "No .env or .env.local found: add it to a .env file.";

function makeFakePage(): { page: Page; emitter: EventEmitter } {
  const emitter = new EventEmitter();
  return { page: emitter as unknown as Page, emitter };
}

function pageError(message: string, stack?: string): Error {
  const err = new Error(message);
  if (stack) err.stack = stack;
  return err;
}

function neverReady(): Promise<never> {
  return new Promise((_, reject) => {
    const err = new Error("Timeout 30000ms exceeded.");
    err.name = "TimeoutError";
    setTimeout(() => reject(err), 5);
  });
}

async function failureOf(
  emit: (emitter: EventEmitter) => void,
  envRemedy?: () => string | undefined,
): Promise<string> {
  const { page, emitter } = makeFakePage();
  const capture = attachPageErrorCapture(page);
  emit(emitter);
  try {
    await waitForReadyOrFatal(neverReady, capture, "component harness", envRemedy);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("readiness wait resolved unexpectedly");
}

describe("a page error captured before the readiness wait started", () => {
  it("leads the readiness failure instead of the timeout headline", async () => {
    const message = await failureOf((emitter) => {
      emitter.emit("pageerror", pageError("Unable to determine current node version"));
    });

    expect(message).toContain("failed before it became ready");
    expect(message).toContain("Unable to determine current node version");
    expect(message).not.toContain("did not become ready within timeout");
  });

  it("names the throwing module when the stack carries a source frame", async () => {
    const message = await failureOf((emitter) => {
      emitter.emit(
        "pageerror",
        pageError(
          "Unable to determine current node version",
          [
            "Error: Unable to determine current node version",
            "    at getNodeVersion (/@fs/e/repositories-run5/documenso/packages/ui/primitives/dialog.tsx:1:1)",
          ].join("\n"),
        ),
      );
    });

    expect(message).toContain("dialog.tsx");
  });

  it("reports every captured error, not only the first", async () => {
    const message = await failureOf((emitter) => {
      emitter.emit("pageerror", pageError("first boom"));
      emitter.emit("pageerror", pageError("second boom"));
      emitter.emit("pageerror", pageError("third boom"));
    });

    expect(message).toContain("first boom");
    expect(message).toContain("second boom");
    expect(message).toContain("third boom");
  });

  it("keeps the existing bucket cap and discloses what it dropped", async () => {
    const message = await failureOf((emitter) => {
      for (let i = 0; i < 25; i++) emitter.emit("pageerror", pageError(`boom ${i}`));
    });

    expect(message).toContain("boom 19");
    expect(message).not.toContain("boom 20");
    expect(message).toContain("(+5 more dropped)");
  });
});

describe("the environment-file remedy", () => {
  it("stays off an error that names no environment variable", async () => {
    const message = await failureOf(
      (emitter) => emitter.emit("pageerror", pageError("Unable to determine current node version")),
      () => ENV_REMEDY,
    );

    expect(message).not.toContain(ENV_REMEDY);
  });

  it("attaches to a process.env failure", async () => {
    const message = await failureOf(
      (emitter) => emitter.emit("pageerror", pageError("process.env.DATABASE_URL is not defined")),
      () => ENV_REMEDY,
    );

    expect(message).toContain(ENV_REMEDY);
  });

  it("attaches to an import.meta.env failure", async () => {
    const message = await failureOf(
      (emitter) =>
        emitter.emit("pageerror", pageError("import.meta.env.VITE_API_URL is undefined")),
      () => ENV_REMEDY,
    );

    expect(message).toContain(ENV_REMEDY);
  });

  it("attaches to an env-validation failure", async () => {
    const message = await failureOf(
      (emitter) => emitter.emit("pageerror", pageError("Invalid environment variables: SESSION_SECRET")),
      () => ENV_REMEDY,
    );

    expect(message).toContain(ENV_REMEDY);
  });

  it("stays off a plain timeout that captured nothing", async () => {
    const message = await failureOf(() => {}, () => ENV_REMEDY);

    expect(message).toContain("did not become ready within timeout");
    expect(message).not.toContain(ENV_REMEDY);
  });
});

// M108 review: enterHarness re-runs the readiness wait after a mid-session
// navigation, and only drain() cleared the captured fatal. A fatal captured
// after the last drain would lead the NEXT segment's unrelated timeout.
describe("a page error captured before the last navigation", () => {
  it("does not lead the readiness failure of the document that followed it", async () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("pageerror", pageError("segment N boom"));

    await gotoWithErrorContext(
      { goto: async () => undefined },
      "http://localhost/harness.html",
      capture,
      "component harness",
    );

    let message = "";
    try {
      await waitForReadyOrFatal(neverReady, capture, "component harness");
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("did not become ready within timeout");
    expect(message).not.toContain("failed before it became ready");
  });

  it("still leads when the fatal arrives during the new document's evaluation", async () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("pageerror", pageError("segment N boom"));

    await gotoWithErrorContext(
      {
        goto: async () => {
          emitter.emit("pageerror", pageError("segment N+1 boom"));
        },
      },
      "http://localhost/harness.html",
      capture,
      "component harness",
    );

    let message = "";
    try {
      await waitForReadyOrFatal(neverReady, capture, "component harness");
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("failed before it became ready");
    expect(message).toContain("segment N+1 boom");
  });
});
