import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { helpText } from "../../src/cli/index.js";

function exitOneLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().startsWith("1 "));
  expect(line).toBeDefined();
  return line!;
}

describe("what --help says exit 1 covers", () => {
  it("names the render error beside the budget and the regression", () => {
    const line = exitOneLine(helpText());
    expect(line).toContain("over budget");
    expect(line).toContain("--check");
    expect(line).toContain("render error");
  });

  it("still describes exit 0 and exit 2 as they are", () => {
    const text = helpText();
    expect(text).toContain("0   every measured component passed");
    expect(text).toContain("2   setup error");
  });
});

describe("what the README says exit 1 covers", () => {
  it("agrees with the help text", () => {
    const readme = fs.readFileSync("README.md", "utf-8");
    const line = readme.split("\n").find((l) => l.includes("Exit codes: 0 pass"));
    expect(line).toBeDefined();
    expect(line).toContain("render error");
  });

  it("shows the render-error section a worked example and the wrapper recipe", () => {
    const readme = fs.readFileSync("README.md", "utf-8");
    const section = readme.slice(readme.indexOf("### Render errors"));
    const body = section.slice(0, section.indexOf("### Harness fault"));
    expect(body).toContain("MantineProvider was not found");
    expect(body).toContain("#provider-wrapper");
  });
});
