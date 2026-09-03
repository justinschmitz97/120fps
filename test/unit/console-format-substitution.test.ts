import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { Page } from "playwright";
import { attachPageErrorCapture, substituteConsoleFormat } from "../../src/page-errors.js";

function makeFakePage(): { page: Page; emitter: EventEmitter } {
  const emitter = new EventEmitter();
  return { page: emitter as unknown as Page, emitter };
}

// Playwright renders a console message as the format string followed by every
// argument's preview, joined by a space, and exposes the same previews through
// `args()`.
function makeConsoleMessage(type: string, args: string[]) {
  return {
    type: () => type,
    text: () => args.join(" "),
    args: () => args.map((arg) => ({ toString: () => arg })),
  };
}

describe("substituting console format placeholders", () => {
  it("fills %s from the argument that follows the format string", () => {
    expect(substituteConsoleFormat("Warning: %s is invalid size", ["Warning: %s is invalid", "size"])).toBe(
      "Warning: size is invalid",
    );
  });

  it("fills the numeric and object placeholders in order", () => {
    expect(
      substituteConsoleFormat("%s rendered %d times as %o x 12 [object Object]", [
        "%s rendered %d times as %o",
        "x",
        "12",
        "[object Object]",
      ]),
    ).toBe("x rendered 12 times as [object Object]");
  });

  it("turns a literal %% into one percent sign and consumes no argument", () => {
    expect(substituteConsoleFormat("100%% of %s done all", ["100%% of %s done", "all"])).toBe(
      "100% of all done",
    );
  });

  it("drops a %c style argument from the rendered text", () => {
    expect(substituteConsoleFormat("%cstyled color: red", ["%cstyled", "color: red"])).toBe("styled");
  });

  it("keeps surplus arguments appended", () => {
    expect(substituteConsoleFormat("%s and more one two", ["%s and more", "one", "two"])).toBe(
      "one and more two",
    );
  });

  it("leaves a placeholder with no argument literal", () => {
    expect(substituteConsoleFormat("%s and %s one", ["%s and %s", "one"])).toBe("one and %s");
  });

  it("returns the message untouched when it carries no format string", () => {
    expect(substituteConsoleFormat("plain failure", ["plain failure"])).toBe("plain failure");
    expect(substituteConsoleFormat("plain failure", [])).toBe("plain failure");
  });
});

describe("capturing a console error that used a format string", () => {
  it("records the substituted text", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("console", makeConsoleMessage("error", ["Warning: %s is invalid", "size"]));
    expect(capture.errors).toEqual(["Warning: size is invalid"]);
  });

  it("hands the substituted text to the segment drain the JSON report reads", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("console", makeConsoleMessage("error", ["A %s must not be %s", "prop", "both"]));
    expect(capture.drain().messages).toEqual(["A prop must not be both"]);
  });

  it("dedupes two identical calls after substitution, not before", () => {
    const { page, emitter } = makeFakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("console", makeConsoleMessage("error", ["Warning: %s failed", "open"]));
    emitter.emit("console", makeConsoleMessage("error", ["Warning: %s failed", "open"]));
    emitter.emit("console", makeConsoleMessage("error", ["Warning: %s failed", "close"]));
    expect(capture.errors).toEqual(["Warning: open failed (×2)", "Warning: close failed"]);
  });
});
