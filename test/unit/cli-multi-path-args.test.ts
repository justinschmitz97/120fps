import { describe, it, expect } from "vitest";
import { parseArgs, defaultJsonPathFor, resolveReportPaths } from "../../src/cli.js";

describe("D12: multi-path parsing", () => {
  it("collects multiple component paths in order", () => {
    const args = parseArgs(["./A.tsx", "./B.tsx", "./C.tsx"]);
    expect(args.componentPath).toBe("./A.tsx");
    expect(args.componentPaths).toEqual(["./A.tsx", "./B.tsx", "./C.tsx"]);
    expect(args.error).toBeUndefined();
  });

  it("single path keeps componentPaths as singleton and no error", () => {
    const args = parseArgs(["./A.tsx"]);
    expect(args.componentPaths).toEqual(["./A.tsx"]);
    expect(args.error).toBeUndefined();
  });

  it("rejects --fixture with multiple paths", () => {
    const args = parseArgs(["./A.tsx", "./B.tsx", "--fixture", "./A.fixture.tsx"]);
    expect(args.error).toMatch(/--fixture/);
  });

  // Superseded by M32 D5: a directory argument expands to many components, so
  // --json names where reports go rather than being ambiguous.
  it("accepts explicit --json with multiple paths", () => {
    const args = parseArgs(["./A.tsx", "./B.tsx", "--json", "out.json"]);
    expect(args.error).toBeUndefined();
  });

  it("allows explicit --json with a single path", () => {
    const args = parseArgs(["./A.tsx", "--json", "out.json"]);
    expect(args.error).toBeUndefined();
    expect(args.jsonPath).toBe("out.json");
  });

  it("multiple paths without --json keep the default jsonPath untouched", () => {
    const args = parseArgs(["./A.tsx", "./B.tsx"]);
    expect(args.error).toBeUndefined();
    expect(args.jsonPath).toBe("120fps-report.json");
  });

  it("flags still parse after multiple positionals", () => {
    const args = parseArgs(["./A.tsx", "./B.tsx", "--ci"]);
    expect(args.ci).toBe(true);
    expect(args.componentPaths).toHaveLength(2);
  });
});

describe("D12: per-component report naming", () => {
  it("derives 120fps-report.<stem>.json from the component path", () => {
    expect(defaultJsonPathFor("./components/ui/Button.tsx")).toBe("120fps-report.Button.json");
  });

  it("handles windows separators and no directory", () => {
    expect(defaultJsonPathFor("components\\ui\\Card.tsx")).toBe("120fps-report.Card.json");
    expect(defaultJsonPathFor("Plain.tsx")).toBe("120fps-report.Plain.json");
  });

  it("resolveReportPaths is stem-based and collision-free in path order", () => {
    expect(
      resolveReportPaths(["./a/Button.tsx", "./b/Button.tsx", "./Card.tsx", "./c/Button.tsx"]),
    ).toEqual([
      "120fps-report.Button.json",
      "120fps-report.Button-2.json",
      "120fps-report.Card.json",
      "120fps-report.Button-3.json",
    ]);
  });

  it("resolveReportPaths on a single path returns the plain stem name", () => {
    expect(resolveReportPaths(["./X.tsx"])).toEqual(["120fps-report.X.json"]);
  });
});
