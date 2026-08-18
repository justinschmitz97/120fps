import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/cli.js";

describe("--no-deltas CLI flag", () => {
  it("parses --no-deltas flag", () => {
    const args = parseArgs(["./Button.tsx", "--no-deltas"]);
    expect(args.noDeltas).toBe(true);
    expect(args.error).toBeUndefined();
  });

  it("noDeltas defaults to undefined when not specified", () => {
    const args = parseArgs(["./Button.tsx"]);
    expect(args.noDeltas).toBeUndefined();
  });
});
