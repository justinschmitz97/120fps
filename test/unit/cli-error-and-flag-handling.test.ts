import { describe, it, expect, afterEach } from "vitest";
import {
  parseArgs,
  resolveIsolationOption,
  formatCliError,
  helpText,
  KNOWN_FLAGS,
  isDebugStackEnabled,
  wrapperNotFoundMessage,
  stylesheetNotFoundMessage,
  nodeVersionError,
  MIN_NODE_MAJOR,
  resolveFatalProcessError,
  resetFatalProcessErrorGuard,
} from "../../src/cli.js";
import { resolveWrapPath, resolveCssFiles } from "../../src/analyze.js";

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

describe("D7: isDebugStackEnabled: DEBUG convention", () => {
  it("enabled when DEBUG is exactly '1'", () => {
    expect(isDebugStackEnabled("1")).toBe(true);
  });

  it("enabled when DEBUG is exactly 'true'", () => {
    expect(isDebugStackEnabled("true")).toBe(true);
  });

  it("enabled when DEBUG is exactly '*'", () => {
    expect(isDebugStackEnabled("*")).toBe(true);
  });

  it("enabled when DEBUG contains 120fps", () => {
    expect(isDebugStackEnabled("120fps:*")).toBe(true);
  });

  it("disabled when DEBUG is a superstring of '1' that isn't exact and doesn't contain 120fps", () => {
    expect(isDebugStackEnabled("10")).toBe(false);
  });

  it("disabled when DEBUG is '0' or 'false'", () => {
    expect(isDebugStackEnabled("0")).toBe(false);
    expect(isDebugStackEnabled("false")).toBe(false);
  });

  it("disabled when DEBUG is unset", () => {
    expect(isDebugStackEnabled(undefined)).toBe(false);
  });

  it("formatCliError prints a stack when DEBUG=1", () => {
    const out = formatCliError(new Error("boom"), "1");
    expect(out).toContain("at ");
  });

  it("formatCliError prints a stack when DEBUG=true", () => {
    const out = formatCliError(new Error("boom"), "true");
    expect(out).toContain("at ");
  });

  it("formatCliError prints a stack when DEBUG=*", () => {
    const out = formatCliError(new Error("boom"), "*");
    expect(out).toContain("at ");
  });
});

describe("D8: --wrap / --css error wording matches analyze.ts", () => {
  it("cli wrapperNotFoundMessage matches the message resolveWrapPath throws", () => {
    const missing = "./definitely-not-a-real-wrap-file.tsx";
    let thrown: string | undefined;
    try {
      resolveWrapPath({ wrapPath: missing }, process.cwd());
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown).toBe(wrapperNotFoundMessage(missing));
  });

  it("cli stylesheetNotFoundMessage matches the message resolveCssFiles throws", () => {
    const missing = "./definitely-not-a-real-stylesheet.css";
    let thrown: string | undefined;
    try {
      resolveCssFiles({ cssFiles: [missing] }, process.cwd());
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown).toBe(stylesheetNotFoundMessage(missing));
  });
});

// M72: engines: >=22 in package.json is declarative only; npx only soft-warns
// below it. main() checks process.version itself, before any other work.
describe("node version gate", () => {
  it(`requires Node ${MIN_NODE_MAJOR}+`, () => {
    expect(MIN_NODE_MAJOR).toBe(22);
  });

  it("rejects a major version below the floor", () => {
    const message = nodeVersionError("v18.19.0");
    expect(message).toBeDefined();
    expect(message).toContain("Node 22+ required");
    expect(message).toContain("v18.19.0");
  });

  it("rejects the last unsupported major", () => {
    expect(nodeVersionError("v21.7.3")).toBeDefined();
  });

  it("accepts the floor version", () => {
    expect(nodeVersionError("v22.0.0")).toBeUndefined();
  });

  it("accepts a version above the floor", () => {
    expect(nodeVersionError("v24.15.0")).toBeUndefined();
  });

  it("does not reject an unparseable version string", () => {
    expect(nodeVersionError("not-a-version")).toBeUndefined();
  });
});

// M79 behavior 2: no process.on("unhandledRejection"/"uncaughtException")
// handler existed anywhere; Vite's fire-and-forget dependency-optimizer scan
// could reject after buildAndServe's own try/catch already exited
// successfully, which Node's default --unhandled-rejections=throw then
// escalated to an uncaught exception with exit code 1 (documented at
// cli.ts's own --help table as "a verdict failed" — wrong for a setup/harness
// failure). resolveFatalProcessError is the pure decision the real
// process.on handlers (registered only under isDirectRun, so importing
// cli.ts from a test never installs them) apply.
describe("M79 behavior 2: resolveFatalProcessError", () => {
  afterEach(() => {
    resetFatalProcessErrorGuard();
  });

  it("formats the same way formatCliError does, and exits 2 (setup/harness failure)", () => {
    const err = new Error("Build failed with 1 error: Could not resolve \"./version\"");
    const resolved = resolveFatalProcessError(err, undefined);
    expect(resolved).toBeDefined();
    expect(resolved!.exitCode).toBe(2);
    expect(resolved!.output).toBe(formatCliError(err, undefined));
    expect(resolved!.output).toContain("Build failed with 1 error");
  });

  it("prints no raw stack by default, and does under DEBUG=120fps (same DEBUG contract as formatCliError)", () => {
    const err = new Error("boom");
    const withoutDebug = resolveFatalProcessError(err, undefined);
    expect(withoutDebug!.output).toBe(formatCliError(err, undefined));
    expect(withoutDebug!.output).not.toContain(err.stack!);
    resetFatalProcessErrorGuard();
    const withDebug = resolveFatalProcessError(err, "120fps");
    expect(withDebug!.output).toBe(formatCliError(err, "120fps"));
    expect(withDebug!.output).toContain(err.stack!);
  });

  it("handles a non-Error thrown value", () => {
    const resolved = resolveFatalProcessError("raw string rejection", undefined);
    expect(resolved!.output).toContain("raw string rejection");
    expect(resolved!.exitCode).toBe(2);
  });

  it("fires only once: a second rejection arriving before the process actually exits is a no-op", () => {
    const first = resolveFatalProcessError(new Error("first"), undefined);
    const second = resolveFatalProcessError(new Error("second"), undefined);
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
  });

  it("resetFatalProcessErrorGuard re-arms the guard for the next case", () => {
    expect(resolveFatalProcessError(new Error("a"), undefined)).toBeDefined();
    resetFatalProcessErrorGuard();
    expect(resolveFatalProcessError(new Error("b"), undefined)).toBeDefined();
  });
});

// M79 taxonomy-F1: readEnvDefines reads only .env/.env.local and defines
// process.env as {} — neither --help nor README mentioned this at all
// (both grepped, zero hits, confirmed in specs/milestones/M76-M83-MAP.md).
describe("M79 taxonomy-F1: --help documents the .env contract", () => {
  it("names .env / .env.local as the only source", () => {
    expect(helpText()).toContain(".env");
    expect(helpText()).toContain(".env.local");
  });

  it("names the NEXT_PUBLIC_/VITE_ prefix requirement", () => {
    expect(helpText()).toContain("NEXT_PUBLIC_");
    expect(helpText()).toContain("VITE_");
  });

  it("states the invoking shell's own environment is not passed through", () => {
    expect(helpText()).toMatch(/shell.{0,40}environment.{0,40}not/i);
  });
});
