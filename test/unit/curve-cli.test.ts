import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/cli.js";

describe("--curve CLI flag", () => {
  it("parses --curve as boolean true", () => {
    const args = parseArgs(["./Button.tsx", "--curve"]);
    expect(args.curve).toBe(true);
    expect(args.error).toBeUndefined();
  });

  it("parses --curve with propName:type argument", () => {
    const args = parseArgs(["./Button.tsx", "--curve", "items:array"]);
    expect(args.curve).toBe("items:array");
    expect(args.error).toBeUndefined();
  });

  it("parses --curve with numeric type", () => {
    const args = parseArgs(["./Button.tsx", "--curve", "count:number"]);
    expect(args.curve).toBe("count:number");
    expect(args.error).toBeUndefined();
  });

  it("rejects --curve with invalid type", () => {
    const args = parseArgs(["./Button.tsx", "--curve", "items:string"]);
    expect(args.error).toContain("--curve");
  });

  it("curve defaults to undefined when not specified", () => {
    const args = parseArgs(["./Button.tsx"]);
    expect(args.curve).toBeUndefined();
  });

  it("--curve is a known flag (no error)", () => {
    const args = parseArgs(["./Button.tsx", "--curve"]);
    expect(args.error).toBeUndefined();
  });

  it("--curve works alongside other flags", () => {
    const args = parseArgs(["./Button.tsx", "--curve", "--ci", "--scale", "1,5,20"]);
    expect(args.curve).toBe(true);
    expect(args.ci).toBe(true);
    expect(args.scale).toEqual([1, 5, 20]);
    expect(args.error).toBeUndefined();
  });
});

describe("--no-curve CLI flag", () => {
  it("parses --no-curve flag", () => {
    const args = parseArgs(["./Button.tsx", "--no-curve"]);
    expect(args.noCurve).toBe(true);
    expect(args.error).toBeUndefined();
  });

  it("noCurve defaults to undefined when not specified", () => {
    const args = parseArgs(["./Button.tsx"]);
    expect(args.noCurve).toBeUndefined();
  });

  it("--no-curve is a known flag (no error)", () => {
    const args = parseArgs(["./Button.tsx", "--no-curve"]);
    expect(args.error).toBeUndefined();
  });

  it("--curve and --no-curve together: --no-curve wins", () => {
    const args = parseArgs(["./Button.tsx", "--curve", "--no-curve"]);
    expect(args.curve).toBe(true);
    expect(args.noCurve).toBe(true);
    expect(args.error).toBeUndefined();
  });
});

describe("--curve flag does not consume next positional as arg when not prop:type pattern", () => {
  it("--curve followed by a flag does not consume it", () => {
    const args = parseArgs(["./Button.tsx", "--curve", "--ci"]);
    expect(args.curve).toBe(true);
    expect(args.ci).toBe(true);
  });

  it("--curve followed by component path is treated as boolean", () => {
    const args = parseArgs(["--curve", "./Button.tsx"]);
    expect(args.curve).toBe(true);
    expect(args.componentPath).toBe("./Button.tsx");
  });
});
