import { describe, it, expect } from "vitest";
import { parseArgs, resolveIsolationOption, formatCliError, helpText, KNOWN_FLAGS } from "../../src/cli.js";

describe("D3: resolveIsolationOption", () => {
  it("returns isolation options when --isolate is set and --no-isolate is not", () => {
    const opt = resolveIsolationOption({ isolate: ["mount"], memoryCycles: 30 });
    expect(opt).toEqual({ phases: ["mount"], memoryCycles: 30 });
  });

  it("returns undefined when --no-isolate is set alongside --isolate", () => {
    const opt = resolveIsolationOption({ isolate: ["mount", "rerender"], noIsolate: true });
    expect(opt).toBeUndefined();
  });

  it("returns undefined when only --no-isolate is set (no-op)", () => {
    expect(resolveIsolationOption({ noIsolate: true })).toBeUndefined();
  });

  it("returns undefined when neither flag is set", () => {
    expect(resolveIsolationOption({})).toBeUndefined();
  });

  it("--isolate all + --no-isolate → undefined", () => {
    const args = parseArgs(["./Button.tsx", "--isolate", "all", "--no-isolate"]);
    expect(args.error).toBeUndefined();
    expect(resolveIsolationOption(args)).toBeUndefined();
  });

  it("omits memoryCycles when not given", () => {
    const opt = resolveIsolationOption({ isolate: ["memory"] });
    expect(opt).toEqual({ phases: ["memory"], memoryCycles: undefined });
  });
});

describe("D3: parseArgs --isolate with --no-isolate", () => {
  it("both flags parse without error", () => {
    const args = parseArgs(["./Button.tsx", "--isolate", "mount", "--no-isolate"]);
    expect(args.error).toBeUndefined();
    expect(args.isolate).toEqual(["mount"]);
    expect(args.noIsolate).toBe(true);
  });
});

describe("D3: help text", () => {
  it("--no-isolate line says it overrides --isolate", () => {
    expect(helpText()).toContain("Disable isolation mode (overrides --isolate)");
  });

  it("lists --no-deltas", () => {
    expect(helpText()).toContain("--no-deltas");
  });

  it("every known flag appears in the help text (parity guard)", () => {
    const text = helpText();
    for (const flag of KNOWN_FLAGS) {
      expect(text, `help text missing ${flag}`).toContain(flag);
    }
  });
});

describe("D6: formatCliError", () => {
  it("formats a plain Error message", () => {
    expect(formatCliError(new Error("boom"), undefined)).toBe("Error: boom\n");
  });

  it("stringifies non-Error throwables", () => {
    expect(formatCliError("raw string failure", undefined)).toBe("Error: raw string failure\n");
  });

  it("prints stack when DEBUG contains 120fps", () => {
    const err = new Error("boom");
    const out = formatCliError(err, "120fps");
    expect(out).toContain("Error: boom");
    expect(out).toContain(err.stack!.split("\n")[1].trim());
  });

  it("prints stack when DEBUG is a superstring like 120fpsx (substring contract)", () => {
    const out = formatCliError(new Error("boom"), "120fpsx");
    expect(out).toContain("at ");
  });

  it("no stack when DEBUG is unset", () => {
    const out = formatCliError(new Error("boom"), undefined);
    expect(out).not.toContain("    at ");
  });

  it("no stack when DEBUG does not contain 120fps", () => {
    const out = formatCliError(new Error("boom"), "vite:*");
    expect(out).not.toContain("    at ");
  });

  it("appends playwright install hint on missing-browser error (Executable doesn't exist)", () => {
    const out = formatCliError(
      new Error("browserType.launch: Executable doesn't exist at C:\\ms-playwright\\chromium\\chrome.exe"),
      undefined,
    );
    expect(out).toContain("npx playwright install chromium");
  });

  it("appends hint when message mentions playwright install (case-insensitive)", () => {
    const out = formatCliError(new Error("Please run: Playwright Install"), undefined);
    expect(out).toContain("npx playwright install chromium");
  });

  it("no hint for unrelated errors", () => {
    const out = formatCliError(new Error("Component file not found: x.tsx"), undefined);
    expect(out).not.toContain("playwright install chromium");
  });

  it("no stack for non-Error even with DEBUG set", () => {
    const out = formatCliError("bare failure", "120fps");
    expect(out).toBe("Error: bare failure\n");
  });
});
