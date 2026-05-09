import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/cli.js";

describe("--isolate flag", () => {
  it("parses single phase", () => {
    const args = parseArgs(["./Button.tsx", "--isolate", "mount"]);
    expect(args.isolate).toEqual(["mount"]);
    expect(args.error).toBeUndefined();
  });

  it("parses comma-separated phases", () => {
    const args = parseArgs(["./Button.tsx", "--isolate", "mount,rerender,memory"]);
    expect(args.isolate).toEqual(["mount", "rerender", "memory"]);
  });

  it("parses all", () => {
    const args = parseArgs(["./Button.tsx", "--isolate", "all"]);
    expect(args.isolate).toEqual(["mount", "rerender", "unmount", "memory", "strictmode"]);
  });

  it("errors on invalid phase", () => {
    const args = parseArgs(["./Button.tsx", "--isolate", "bogus"]);
    expect(args.error).toContain("bogus");
  });

  it("errors when value missing", () => {
    const args = parseArgs(["./Button.tsx", "--isolate"]);
    expect(args.error).toBeDefined();
  });

  it("deduplicates repeated phases", () => {
    const args = parseArgs(["./Button.tsx", "--isolate", "mount,mount,rerender"]);
    expect(args.isolate).toEqual(["mount", "rerender"]);
  });
});

describe("--memory-cycles flag", () => {
  it("parses positive integer", () => {
    const args = parseArgs(["./Button.tsx", "--isolate", "memory", "--memory-cycles", "50"]);
    expect(args.memoryCycles).toBe(50);
    expect(args.error).toBeUndefined();
  });

  it("errors on non-integer", () => {
    const args = parseArgs(["./Button.tsx", "--memory-cycles", "abc"]);
    expect(args.error).toContain("--memory-cycles");
  });

  it("errors on zero", () => {
    const args = parseArgs(["./Button.tsx", "--memory-cycles", "0"]);
    expect(args.error).toContain("--memory-cycles");
  });
});

describe("--no-isolate flag", () => {
  it("parses --no-isolate", () => {
    const args = parseArgs(["./Button.tsx", "--no-isolate"]);
    expect(args.noIsolate).toBe(true);
    expect(args.error).toBeUndefined();
  });
});

describe("mutual exclusivity", () => {
  it("--isolate + --curve → error", () => {
    const args = parseArgs(["./Button.tsx", "--isolate", "mount", "--curve"]);
    expect(args.error).toContain("--isolate");
    expect(args.error).toContain("--curve");
  });

  it("--isolate + --matrix → error", () => {
    const args = parseArgs(["./Button.tsx", "--isolate", "mount", "--matrix"]);
    expect(args.error).toContain("--isolate");
    expect(args.error).toContain("--matrix");
  });

  it("--isolate + --budget is fine", () => {
    const args = parseArgs(["./Button.tsx", "--isolate", "mount", "--budget"]);
    expect(args.error).toBeUndefined();
  });
});
