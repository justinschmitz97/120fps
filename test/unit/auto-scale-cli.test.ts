import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/cli.js";

describe("--no-auto-scale CLI flag", () => {
  it("parses --no-auto-scale flag", () => {
    const args = parseArgs(["./Button.tsx", "--no-auto-scale"]);
    expect(args.noAutoScale).toBe(true);
    expect(args.error).toBeUndefined();
  });

  it("noAutoScale defaults to undefined when not specified", () => {
    const args = parseArgs(["./Button.tsx"]);
    expect(args.noAutoScale).toBeUndefined();
  });

  it("--no-auto-scale is a known flag (no error)", () => {
    const args = parseArgs(["./Button.tsx", "--no-auto-scale"]);
    expect(args.error).toBeUndefined();
  });

  it("--no-auto-scale works alongside other flags", () => {
    const args = parseArgs(["./Button.tsx", "--no-auto-scale", "--ci", "--no-deltas"]);
    expect(args.noAutoScale).toBe(true);
    expect(args.ci).toBe(true);
    expect(args.noDeltas).toBe(true);
    expect(args.error).toBeUndefined();
  });
});
