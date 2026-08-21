import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CSS_FALLBACK_WARNING,
  CSS_PLACEHOLDER_SKIPPED_WARNING,
  CSS_RESET_SKIPPED_WARNING,
  RESET_STYLESHEET_STEMS,
  discoverGlobalCss,
  isOptInResetName,
  largestStylesheet,
  rankedStylesheets,
  stylesheetRuleCount,
} from "../../src/harness.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-css-candidate-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(relative: string, body: string): string {
  const full = path.join(tmpDir, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
}

describe("stylesheetRuleCount", () => {
  it("counts zero for a pure passthrough import", () => {
    const file = write("a.css", '@import "pkg";');
    expect(stylesheetRuleCount(file)).toBe(0);
  });

  it("ignores comments and @import/@charset/@use statements", () => {
    const file = write(
      "a.css",
      '/* header comment */\n@charset "utf-8";\n@use "sass:math";\n@import "pkg";\n',
    );
    expect(stylesheetRuleCount(file)).toBe(0);
  });

  it("counts real rules", () => {
    const file = write("a.css", ".a{color:red}.b{color:blue}");
    expect(stylesheetRuleCount(file)).toBe(2);
  });

  it("counts a rule that sits alongside a leading import", () => {
    const file = write("a.css", '@import "pkg";\n.a{color:red}');
    expect(stylesheetRuleCount(file)).toBe(1);
  });

  it("does not let a `;` inside a comment truncate the at-rule strip", () => {
    const file = write("a.css", '@import "pkg" /* ; not a terminator */;\n.a{color:red}');
    expect(stylesheetRuleCount(file)).toBe(1);
  });

  it("treats an unreadable file as zero rules", () => {
    expect(stylesheetRuleCount(path.join(tmpDir, "gone.css"))).toBe(0);
  });

  it("counts zero for bare at-rules with no body (dub-F2 shape)", () => {
    // Three @tailwind directives: zero comments, zero @import/@charset/@use,
    // and no `{`. Rule count 0 here is not "only comments and imports".
    const file = write("a.css", "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n");
    expect(stylesheetRuleCount(file)).toBe(0);
  });

  it("treats a file above 2MB as plausible without reading it", () => {
    const file = path.join(tmpDir, "huge.css");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '@import "pkg";'.padEnd(2 * 1024 * 1024 + 1, " "));
    // Content alone would be rule count 0 (pure passthrough); the size guard
    // means this is never actually read, so it must not report 0.
    expect(stylesheetRuleCount(file)).toBeGreaterThan(0);
  });
});

describe("isOptInResetName", () => {
  it("names the recognized reset stems", () => {
    expect(RESET_STYLESHEET_STEMS).toEqual(["reset", "normalize", "preflight", "sanitize"]);
  });

  it("matches each stem regardless of extension or case", () => {
    expect(isOptInResetName("/a/Reset.css")).toBe(true);
    expect(isOptInResetName("/a/normalize.scss")).toBe(true);
    expect(isOptInResetName("/a/PREFLIGHT.css")).toBe(true);
    expect(isOptInResetName("/a/sanitize.css")).toBe(true);
  });

  it("does not match an unrelated name", () => {
    expect(isOptInResetName("/a/theme.css")).toBe(false);
  });

  it("does not match a name that merely contains a stem", () => {
    expect(isOptInResetName("/a/resets-and-tokens.css")).toBe(false);
  });
});

describe("rankedStylesheets", () => {
  it("sorts every candidate descending by size", () => {
    const small = write("a.css", ".a{}");
    const big = write("b.css", ".b{}".padEnd(400, " "));
    expect(rankedStylesheets(tmpDir).map((r) => r.file)).toEqual([big, small]);
  });

  it("ties break on path ascending", () => {
    const a = write("a.css", ".x{}");
    const b = write("b.css", ".x{}");
    expect(rankedStylesheets(tmpDir).map((r) => r.file)).toEqual([a, b]);
  });

  it("agrees with largestStylesheet on the top pick", () => {
    write("a.css", ".a{}");
    write("src/theme.css", ".b{}".padEnd(300, " "));
    expect(rankedStylesheets(tmpDir)[0]?.file).toBe(largestStylesheet(tmpDir));
  });

  it("is empty when the project has no stylesheet", () => {
    expect(rankedStylesheets(tmpDir)).toEqual([]);
  });

  it("excludes CSS modules and dependency/build directories, same as largestStylesheet", () => {
    write("src/widget.module.css", ".w{}".padEnd(800, " "));
    write("node_modules/pkg/dist/style.css", ".p{}".padEnd(900, " "));
    const own = write("src/app.css", ".a{}");
    expect(rankedStylesheets(tmpDir).map((r) => r.file)).toEqual([own]);
  });
});

describe("fallback candidate disqualification inside discoverGlobalCss", () => {
  it("skips an unbuilt placeholder and warns instead of injecting it", () => {
    const placeholder = write("src/styles.css", '@import "pkg";');
    const warnings: string[] = [];
    const result = discoverGlobalCss(tmpDir, warnings);
    expect(result).toEqual({ files: [], source: "none" });
    expect(warnings).toEqual([
      CSS_PLACEHOLDER_SKIPPED_WARNING(path.relative(tmpDir, placeholder).replace(/\\/g, "/")),
    ]);
  });

  it("skips an opt-in reset by filename even though it has real rules", () => {
    const reset = write("components/style/reset.css", "*{margin:0}");
    const warnings: string[] = [];
    const result = discoverGlobalCss(tmpDir, warnings);
    expect(result).toEqual({ files: [], source: "none" });
    expect(warnings).toEqual([
      CSS_RESET_SKIPPED_WARNING(path.relative(tmpDir, reset).replace(/\\/g, "/")),
    ]);
  });

  it("falls through a disqualified candidate to a real stylesheet underneath", () => {
    // Padded via a stripped comment (not raw rule content) so the placeholder
    // outranks the real file by size and the walk visits it first.
    write("src/styles.css", '@import "pkg";\n' + "/* padding */".repeat(50));
    const real = write("src/theme/tokens.css", ".a{color:red}".padEnd(50, " "));
    const warnings: string[] = [];
    const result = discoverGlobalCss(tmpDir, warnings);
    expect(result).toEqual({
      files: [real],
      source: "fallback",
      onlyCandidate: false,
      noEntryInPackage: true,
    });
    expect(
      warnings.some((w) => w.includes("styles.css") && w.includes("no CSS rule with a body")),
    ).toBe(true);
    expect(warnings.some((w) => w.includes("tokens.css"))).toBe(true);
  });

  it("does not disqualify an evidence-backed entry import that is itself near-empty", () => {
    // Scope's opening principle: the two disqualification checks apply only
    // to the largest-stylesheet fallback layer, never to layers 1-3.
    const css = write("src/reset.css", "");
    write("index.html", '<script type="module" src="/src/main.tsx"></script>');
    write("src/main.tsx", 'import "./reset.css";');
    const result = discoverGlobalCss(tmpDir);
    expect(result).toEqual({ files: [css], source: "entry" });
  });
});

describe("CSS_PLACEHOLDER_SKIPPED_WARNING / CSS_RESET_SKIPPED_WARNING", () => {
  it("names the file in each warning", () => {
    expect(CSS_PLACEHOLDER_SKIPPED_WARNING("src/styles.css")).toContain("src/styles.css");
    expect(CSS_RESET_SKIPPED_WARNING("reset.css")).toContain("reset.css");
  });

  // M92 regression (dub-F2): the message must not claim a file's content is
  // "only comments and imports" when rule count 0 came from something else.
  it("does not claim the file is only comments and imports", () => {
    expect(CSS_PLACEHOLDER_SKIPPED_WARNING("src/styles.css")).not.toContain(
      "only comments and imports",
    );
  });

  it("skips a pure @tailwind passthrough without misdescribing its content (dub-F2)", () => {
    const placeholder = write(
      "src/styles.css",
      "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n",
    );
    const warnings: string[] = [];
    const result = discoverGlobalCss(tmpDir, warnings);
    expect(result).toEqual({ files: [], source: "none" });
    expect(warnings).toEqual([
      CSS_PLACEHOLDER_SKIPPED_WARNING(path.relative(tmpDir, placeholder).replace(/\\/g, "/")),
    ]);
    expect(warnings[0]).not.toContain("only comments and imports");
  });
});

describe("CSS_FALLBACK_WARNING opts", () => {
  it("names the pick as the only stylesheet when it is", () => {
    const warning = CSS_FALLBACK_WARNING("src/theme/tokens.css", {
      onlyCandidate: true,
      noEntryInPackage: false,
    });
    expect(warning).toContain("the only stylesheet found under this project");
    expect(warning).not.toContain("no application entry");
  });

  it("names the pick as the largest stylesheet when it is not the only one", () => {
    const warning = CSS_FALLBACK_WARNING("src/theme/tokens.css", {
      onlyCandidate: false,
      noEntryInPackage: false,
    });
    expect(warning).toContain("the largest stylesheet found under this project");
  });

  it("adds the no-entry note when the package has no application entry of its own", () => {
    const warning = CSS_FALLBACK_WARNING("src/theme/tokens.css", {
      onlyCandidate: true,
      noEntryInPackage: true,
    });
    expect(warning).toContain("this package has no application entry");
  });

  it("omits the no-entry note when the package does have one", () => {
    const warning = CSS_FALLBACK_WARNING("src/theme/tokens.css", {
      onlyCandidate: false,
      noEntryInPackage: false,
    });
    expect(warning).not.toContain("this package has no application entry");
  });

  // M92 regression (excalidraw-F6): the pick is ranked by size, not
  // arbitrary, even when no import chain corroborates it -- the wording must
  // not read as "no evidence at all" for a pick the run demonstrably ranked.
  it("does not claim the pick has no evidence when it was ranked by size", () => {
    const warning = CSS_FALLBACK_WARNING("css/styles.scss", {
      onlyCandidate: false,
      noEntryInPackage: true,
    });
    expect(warning).not.toContain("no evidence behind it at all");
    expect(warning).not.toContain("no import evidence");
    expect(warning).toContain("the largest stylesheet found under this project");
    expect(warning).toContain("ranked by size alone");
  });
});
