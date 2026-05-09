import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/cli.js";

describe("--save-baseline flag", () => {
  it("parses --save-baseline", () => {
    const args = parseArgs(["./Button.tsx", "--save-baseline"]);
    expect(args.saveBaseline).toBe(true);
    expect(args.error).toBeUndefined();
  });
});

describe("--check flag", () => {
  it("parses --check", () => {
    const args = parseArgs(["./Button.tsx", "--check"]);
    expect(args.check).toBe(true);
    expect(args.error).toBeUndefined();
  });
});

describe("--budget flag", () => {
  it("parses --budget", () => {
    const args = parseArgs(["./Button.tsx", "--budget"]);
    expect(args.budget).toBe(true);
    expect(args.error).toBeUndefined();
  });

  it("--budget implies ci and check", () => {
    const args = parseArgs(["./Button.tsx", "--budget"]);
    expect(args.ci).toBe(true);
    expect(args.check).toBe(true);
  });
});

describe("--no-baseline flag", () => {
  it("parses --no-baseline", () => {
    const args = parseArgs(["./Button.tsx", "--no-baseline"]);
    expect(args.noBaseline).toBe(true);
    expect(args.error).toBeUndefined();
  });
});

describe("combined flags", () => {
  it("--ci --check together", () => {
    const args = parseArgs(["./Button.tsx", "--ci", "--check"]);
    expect(args.ci).toBe(true);
    expect(args.check).toBe(true);
  });

  it("--budget --no-baseline together", () => {
    const args = parseArgs(["./Button.tsx", "--budget", "--no-baseline"]);
    expect(args.budget).toBe(true);
    expect(args.noBaseline).toBe(true);
    expect(args.ci).toBe(true);
  });

  it("--save-baseline --check together", () => {
    const args = parseArgs(["./Button.tsx", "--save-baseline", "--check"]);
    expect(args.saveBaseline).toBe(true);
    expect(args.check).toBe(true);
  });

  it("--budget --save-baseline together", () => {
    const args = parseArgs(["./Button.tsx", "--budget", "--save-baseline"]);
    expect(args.budget).toBe(true);
    expect(args.saveBaseline).toBe(true);
  });
});

describe("multiple component paths", () => {
  it("parses multiple positional args into componentPaths", () => {
    const args = parseArgs(["./Button.tsx", "./Accordion.tsx", "./Carousel.tsx"]);
    expect(args.componentPath).toBe("./Button.tsx");
    expect(args.componentPaths).toEqual(["./Button.tsx", "./Accordion.tsx", "./Carousel.tsx"]);
  });

  it("single component has componentPaths with one entry", () => {
    const args = parseArgs(["./Button.tsx"]);
    expect(args.componentPaths).toEqual(["./Button.tsx"]);
  });
});
