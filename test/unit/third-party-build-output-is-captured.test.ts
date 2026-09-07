import { describe, it, expect } from "vitest";
import {
  abortRun,
  captureThirdPartyErrors,
  releaseThirdPartyCapture,
  thirdPartyOutputNotice,
} from "../../src/cli/index.js";

const RESOLVE_STACK =
  "Error: Can't resolve '@tailwindcss/typography' in 'E:\\app\\src'\n" +
  "    at finishWithoutResolve (E:\\app\\node_modules\\.pnpm\\enhanced-resolve@5.19.0\\node_modules\\enhanced-resolve\\lib\\Resolver.js:586:18)";

const COVERING_WARNING =
  "src/app/globals.css did not compile ([postcss] tailwindcss: Can't resolve " +
  "'@tailwindcss/typography' in 'E:\\app\\src'); the stylesheet was not injected";

describe("output a third party writes while the harness builds", () => {
  it("is captured instead of streamed", () => {
    const written: string[] = [];
    const release = captureThirdPartyErrors({ write: (chunk) => written.push(chunk) });
    console.error(RESOLVE_STACK);
    const captured = release();
    expect(written).toEqual([]);
    expect(captured).toEqual([RESOLVE_STACK]);
  });

  it("restores the console it replaced", () => {
    const before = console.error;
    const release = captureThirdPartyErrors({ write: () => {} });
    expect(console.error).not.toBe(before);
    release();
    expect(console.error).toBe(before);
  });

  it("streams instead of capturing under DEBUG", () => {
    const written: string[] = [];
    const release = captureThirdPartyErrors({ write: (chunk) => written.push(chunk), debug: true });
    console.error(RESOLVE_STACK);
    expect(release()).toEqual([]);
    expect(written).toEqual([`${RESOLVE_STACK}
`]);
  });
});

describe("the notice for captured third-party output", () => {
  it("says nothing when a 120fps warning reports the same fact", () => {
    expect(thirdPartyOutputNotice([RESOLVE_STACK], [COVERING_WARNING])).toBeUndefined();
  });

  it("recognises the same fact through a re-worded warning", () => {
    const reworded =
      "  SRC/APP/GLOBALS.CSS did not compile ([postcss] tailwindcss: can't resolve\n" +
      "  '@tailwindcss/typography' in 'e:/app/src'); the stylesheet was not injected";
    expect(thirdPartyOutputNotice([RESOLVE_STACK], [reworded])).toBeUndefined();
  });

  it("still prints a fact no warning mentions at all", () => {
    const unrelated = "styles/emoji.css did not compile ([postcss] tailwindcss: unknown utility)";
    expect(thirdPartyOutputNotice([RESOLVE_STACK], [unrelated])).toBeDefined();
  });

  it("prints the output once, named by the tool that wrote it, when no warning covers it", () => {
    const notice = thirdPartyOutputNotice([RESOLVE_STACK], ["Stylesheets: none found"]);
    expect(notice).toBeDefined();
    expect(notice).toContain("enhanced-resolve");
    expect(notice).toContain("Can't resolve '@tailwindcss/typography'");
    expect(notice!.split("Can't resolve '@tailwindcss/typography'").length - 1).toBe(1);
  });

  it("says nothing when nothing was captured", () => {
    expect(thirdPartyOutputNotice([], [])).toBeUndefined();
  });

  it("makes no claim about which phase wrote it", () => {
    const notice = thirdPartyOutputNotice([RESOLVE_STACK], []);
    expect(notice).not.toContain("while the harness was building");
    expect(notice).toContain("during the run");
  });

  it("names no tool it cannot read from the output", () => {
    const notice = thirdPartyOutputNotice(["something went wrong"], []);
    expect(notice).toContain("a tool the harness build loaded");
  });
});

describe("a teardown that writes through the console it replaced", () => {
  it("gets the console back before an abort sweeps", async () => {
    const before = console.error;
    const release = captureThirdPartyErrors({ write: () => {} });
    expect(console.error).not.toBe(before);
    const swept: string[] = [];
    await abortRun(2, undefined, {
      sweep: () => swept.push("sweep"),
      finalSweep: () => swept.push("finalSweep"),
      exit: () => {},
      timeoutMs: 50,
    });
    expect(console.error).toBe(before);
    expect(swept[0]).toBe("sweep");
    release();
  });

  it("is a no-op when no capture is in force", () => {
    const before = console.error;
    releaseThirdPartyCapture();
    expect(console.error).toBe(before);
  });
});
