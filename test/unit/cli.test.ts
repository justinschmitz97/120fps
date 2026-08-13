import { describe, it, expect } from "vitest";
import { parseArgs, type CliArgs } from "../../src/cli.js";

describe("parseArgs", () => {
  it("parses component path as first positional arg", () => {
    const result = parseArgs(["./Button.tsx"]);
    expect(result.componentPath).toBe("./Button.tsx");
  });

  it("defaults json path to 120fps-report.json", () => {
    const result = parseArgs(["./Button.tsx"]);
    expect(result.jsonPath).toBe("120fps-report.json");
  });

  it("parses --json flag", () => {
    const result = parseArgs(["./Button.tsx", "--json", "out.json"]);
    expect(result.jsonPath).toBe("out.json");
  });

  it("parses --ci flag", () => {
    const result = parseArgs(["./Button.tsx", "--ci"]);
    expect(result.ci).toBe(true);
  });

  it("defaults ci to false", () => {
    const result = parseArgs(["./Button.tsx"]);
    expect(result.ci).toBe(false);
  });

  it("parses --samples", () => {
    const result = parseArgs(["./Button.tsx", "--samples", "5"]);
    expect(result.samples).toBe(5);
  });

  it("parses --threshold-mount", () => {
    const result = parseArgs(["./Button.tsx", "--threshold-mount", "32"]);
    expect(result.thresholdMount).toBe(32);
  });

  it("parses --threshold-interaction", () => {
    const result = parseArgs(["./Button.tsx", "--threshold-interaction", "200"]);
    expect(result.thresholdInteraction).toBe(200);
  });

  it("detects --help flag", () => {
    const result = parseArgs(["--help"]);
    expect(result.help).toBe(true);
  });

  it("detects --version flag", () => {
    const result = parseArgs(["--version"]);
    expect(result.version).toBe(true);
  });

  it("returns error for missing component path (no flags)", () => {
    const result = parseArgs([]);
    expect(result.error).toBeTruthy();
  });

  it("returns error for unknown flags", () => {
    const result = parseArgs(["./Button.tsx", "--unknown"]);
    expect(result.error).toBeTruthy();
  });

  it("returns error for --samples without value", () => {
    const result = parseArgs(["./Button.tsx", "--samples"]);
    expect(result.error).toBeTruthy();
  });

  it("returns error for non-numeric --samples", () => {
    const result = parseArgs(["./Button.tsx", "--samples", "abc"]);
    expect(result.error).toBeTruthy();
  });
});

describe("--scale validation", () => {
  it("accepts 2 or more distinct positive integers", () => {
    const result = parseArgs(["./Button.tsx", "--scale", "1,5,20"]);
    expect(result.error).toBeUndefined();
    expect(result.scale).toEqual([1, 5, 20]);
  });

  it("errors with a single value", () => {
    const result = parseArgs(["./Button.tsx", "--scale", "5"]);
    expect(result.error).toBeTruthy();
  });

  it("errors when duplicates collapse the set below 2 distinct values", () => {
    const result = parseArgs(["./Button.tsx", "--scale", "5,5"]);
    expect(result.error).toBeTruthy();
  });

  it("errors on non-numeric values", () => {
    const result = parseArgs(["./Button.tsx", "--scale", "5,abc"]);
    expect(result.error).toBeTruthy();
  });

  it("errors on zero", () => {
    expect(parseArgs(["./Button.tsx", "--scale", "0,5"]).error).toBeTruthy();
  });

  it("errors on negative values", () => {
    expect(parseArgs(["./Button.tsx", "--scale", "-1,5"]).error).toBeTruthy();
  });

  it("errors when --scale has no value", () => {
    expect(parseArgs(["./Button.tsx", "--scale"]).error).toBeTruthy();
  });
});
