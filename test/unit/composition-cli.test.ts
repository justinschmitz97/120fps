import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/cli.js";

describe("--no-auto-compose CLI flag", () => {
  it("parses --no-auto-compose flag", () => {
    const args = parseArgs(["./Button.tsx", "--no-auto-compose"]);
    expect(args.noAutoCompose).toBe(true);
    expect(args.error).toBeUndefined();
  });

  it("noAutoCompose defaults to undefined when not specified", () => {
    const args = parseArgs(["./Button.tsx"]);
    expect(args.noAutoCompose).toBeUndefined();
  });

  it("--no-auto-compose is a known flag (no error)", () => {
    const args = parseArgs(["./Button.tsx", "--no-auto-compose"]);
    expect(args.error).toBeUndefined();
  });

  it("--no-auto-compose works alongside other flags", () => {
    const args = parseArgs(["./Button.tsx", "--no-auto-compose", "--ci", "--no-deltas"]);
    expect(args.noAutoCompose).toBe(true);
    expect(args.ci).toBe(true);
    expect(args.noDeltas).toBe(true);
    expect(args.error).toBeUndefined();
  });
});
