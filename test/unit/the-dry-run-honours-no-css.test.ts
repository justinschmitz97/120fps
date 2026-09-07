import { describe, it, expect } from "vitest";
import path from "node:path";
import { explainProps } from "../../src/pipeline/index.js";
import { explainPropsOptions } from "../../src/cli/index.js";
import { parseArgs } from "../../src/cli/index.js";

const fixture = (rel: string): string => path.resolve("fixtures", rel);

describe("--no-css in the dry run", () => {
  it("is forwarded by the option builder the CLI hands to the dry run", () => {
    const args = parseArgs(["./Card.tsx", "--explain-props", "--no-css"]);
    expect(explainPropsOptions(args, "./Card.tsx").noCss).toBe(true);
  });

  it("forwards a named stylesheet too", () => {
    const args = parseArgs(["./Card.tsx", "--explain-props", "--css", "./theme.css"]);
    expect(explainPropsOptions(args, "./Card.tsx").cssFiles).toEqual(["./theme.css"]);
  });

  it("reports the same disabled line the real run reports", async () => {
    const explained = await explainProps(fixture("with-css.tsx"), { noCss: true });
    expect(explained.warnings).toContain("Stylesheets: none (--no-css)");
  });

  it("still reports the stylesheet the entry imports when the flag is absent", async () => {
    const explained = await explainProps(fixture("with-css.tsx"));
    const line = explained.warnings.find((w) => w.startsWith("Stylesheets:"));
    expect(line).not.toBe("Stylesheets: none (--no-css)");
  });

  it("reports the named stylesheet as explicit", async () => {
    const explained = await explainProps(fixture("with-css.tsx"), {
      cssFiles: [fixture("with-css.css")],
    });
    const line = explained.warnings.find((w) => w.startsWith("Stylesheets:"));
    expect(line).toContain("(explicit --css)");
  });
});
