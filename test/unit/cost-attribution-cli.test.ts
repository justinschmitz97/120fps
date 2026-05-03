import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/cli.js";

describe("CLI --no-attribution flag", () => {
  it("parses --no-attribution flag", () => {
    const args = parseArgs(["test.tsx", "--no-attribution"]);
    expect(args.noAttribution).toBe(true);
  });

  it("defaults noAttribution to undefined", () => {
    const args = parseArgs(["test.tsx"]);
    expect(args.noAttribution).toBeUndefined();
  });

  it("does not treat --no-attribution as unknown flag", () => {
    const args = parseArgs(["test.tsx", "--no-attribution"]);
    expect(args.error).toBeUndefined();
  });
});
