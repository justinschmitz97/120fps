import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/cli.js";

describe("--matrix flag", () => {
  it("parses --matrix as boolean true", () => {
    const args = parseArgs(["./Button.tsx", "--matrix"]);
    expect(args.matrix).toBe(true);
    expect(args.error).toBeUndefined();
  });

  it("defaults to undefined when not passed", () => {
    const args = parseArgs(["./Button.tsx"]);
    expect(args.matrix).toBeUndefined();
    expect(args.noMatrix).toBeUndefined();
  });

  it("works alongside other flags", () => {
    const args = parseArgs(["./Button.tsx", "--ci", "--matrix", "--no-deltas"]);
    expect(args.matrix).toBe(true);
    expect(args.ci).toBe(true);
    expect(args.noDeltas).toBe(true);
    expect(args.error).toBeUndefined();
  });
});

describe("--no-matrix flag", () => {
  it("parses --no-matrix as boolean true", () => {
    const args = parseArgs(["./Button.tsx", "--no-matrix"]);
    expect(args.noMatrix).toBe(true);
    expect(args.error).toBeUndefined();
  });

  it("both --matrix and --no-matrix stored", () => {
    const args = parseArgs(["./Button.tsx", "--matrix", "--no-matrix"]);
    expect(args.matrix).toBe(true);
    expect(args.noMatrix).toBe(true);
    expect(args.error).toBeUndefined();
  });
});

describe("--matrix is a known flag", () => {
  it("--matrix does not produce unknown flag error", () => {
    const args = parseArgs(["./Button.tsx", "--matrix"]);
    expect(args.error).toBeUndefined();
  });

  it("--no-matrix does not produce unknown flag error", () => {
    const args = parseArgs(["./Button.tsx", "--no-matrix"]);
    expect(args.error).toBeUndefined();
  });
});

describe("--matrix with --curve", () => {
  it("both flags parsed without error", () => {
    const args = parseArgs(["./Button.tsx", "--matrix", "--curve"]);
    expect(args.matrix).toBe(true);
    expect(args.curve).toBe(true);
    expect(args.error).toBeUndefined();
  });
});
