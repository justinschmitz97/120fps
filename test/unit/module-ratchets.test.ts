import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ADR 0005 items 3 and 5: one responsibility per file, at most 800 lines, no
// history in comments, one helper per fact. Each allowlist below records what
// the tree holds today; an entry is deleted the moment its file meets the
// rule, and every assertion fails in both directions so the lists cannot lag.

const SRC = path.resolve("src");
const LINE_LIMIT = 800;

const LINE_CAPS: Record<string, number> = {
  "analysis/explorer.ts": 899,
  "analysis/react-profiler.ts": 890,
  "browser/discovery.ts": 823,
  "props/values.ts": 822,
  "report/budget.ts": 809,
};

const COMMENT_TOKENS: Record<string, number> = {
  "analysis/compare.ts": 2,
  "analysis/explorer.ts": 21,
  "analysis/isolation.ts": 11,
  "analysis/react-profiler.ts": 10,
  "analysis/stress-patterns.ts": 4,
  "browser/discovery.ts": 4,
  "browser/dom.ts": 6,
  "browser/measure.ts": 24,
  "browser/noise.ts": 3,
  "browser/observers.ts": 1,
  "browser/pacing.ts": 2,
  "browser/page-errors.ts": 20,
  "cli/args.ts": 3,
  "cli/errors.ts": 6,
  "cli/gitignore.ts": 3,
  "cli/lifecycle.ts": 14,
  "cli/main.ts": 35,
  "cli/paths.ts": 3,
  "browser/retry.ts": 10,
  "browser/session.ts": 7,
  "browser/settle.ts": 1,
  "browser/trace.ts": 17,
  "harness/build.ts": 31,
  "harness/bundler-failure.ts": 23,
  "harness/css.ts": 27,
  "harness/deps-scan.ts": 43,
  "harness/dirs.ts": 21,
  "harness/entry.ts": 16,
  "harness/env.ts": 1,
  "harness/exports.ts": 7,
  "harness/prebuild.ts": 10,
  "harness/renderer.ts": 9,
  "harness/server.ts": 10,
  "harness/shims.ts": 3,
  "harness/style-tooling.ts": 11,
  "harness/stylesheets.ts": 15,
  "harness/vite-config.ts": 29,
  "harness/workspace-entries.ts": 4,
  "index.ts": 17,
  "pipeline/analyze.ts": 46,
  "pipeline/build-report.ts": 46,
  "pipeline/estimate.ts": 2,
  "pipeline/explain-props.ts": 71,
  "pipeline/fixtures.ts": 5,
  "pipeline/modes/combo.ts": 13,
  "pipeline/modes/context.ts": 11,
  "pipeline/modes/curve.ts": 16,
  "pipeline/modes/isolation.ts": 9,
  "pipeline/modes/matrix.ts": 22,
  "pipeline/phases.ts": 47,
  "pipeline/remedies.ts": 25,
  "pipeline/resolve.ts": 9,
  "pipeline/verdict-reuse.ts": 7,
  "project/compiler-options.ts": 4,
  "project/framework.ts": 7,
  "project/model.ts": 13,
  "project/preflight-gates.ts": 30,
  "project/preflight.ts": 26,
  "project/react-compiler.ts": 5,
  "project/resolve.ts": 9,
  "project/transforms.ts": 10,
  "project/tsconfig-aliases.ts": 30,
  "project/vue-sfc.ts": 9,
  "props/candidates.ts": 19,
  "props/classify.ts": 32,
  "props/composition.ts": 9,
  "props/exports.ts": 12,
  "props/extract.ts": 15,
  "props/presets.ts": 9,
  "props/program.ts": 16,
  "props/schema.ts": 6,
  "props/synthesize.ts": 13,
  "props/values.ts": 22,
  "props/vue.ts": 14,
  "report/budget.ts": 25,
  "report/ci.ts": 7,
  "report/hints.ts": 29,
  "report/metrics.ts": 3,
  "report/phases.ts": 4,
  "report/stats.ts": 13,
  "report/terminal-modes.ts": 20,
  "report/terminal.ts": 19,
  "report/types.ts": 51,
  "shared/run-state.ts": 1,
};

const DUPLICATE_FUNCTIONS: Record<string, string[]> = {
  componentStem: ["cli/paths.ts", "props/candidates.ts"],
};

const HISTORY_TOKEN = /\bM\d{2,3}\b|used to|no longer|previously/g;
const TOP_LEVEL_FUNCTION = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;

function listSources(dir: string, prefix = "", out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "shims") continue;
      listSources(path.join(dir, entry.name), `${prefix}${entry.name}/`, out);
    } else if (entry.name.endsWith(".ts")) {
      out.push(`${prefix}${entry.name}`);
    }
  }
  return out;
}

const FILES = listSources(SRC);
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");

function lineCount(text: string): number {
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

// A `/` starts a regex literal only where an expression is expected: after an
// operator, punctuation, or one of these keywords, never right after a value
// (identifier, number, `)`, `]`, or a closing quote) — the standard division
// vs. regex-literal disambiguation, kept to the minimum this file needs.
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "yield", "await", "case", "else", "do", "throw",
]);

function regexLiteralAllowed(text: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  if (j < 0) return true;
  const c = text[j];
  if (/[A-Za-z0-9_$]/.test(c)) {
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(text[k])) k--;
    return REGEX_PRECEDING_KEYWORDS.has(text.slice(k + 1, j + 1));
  }
  return c !== ")" && c !== "]" && c !== "`" && c !== '"' && c !== "'";
}

// The end index just past a regex literal starting at `start`, honoring `\`
// escapes and a `[...]` character class (where an unescaped `/` does not
// close the regex), or null if no unescaped `/` closes it on the same line —
// then not a regex literal after all, so the caller falls back to `i++`.
function regexLiteralEnd(text: string, start: number): number | null {
  let i = start + 1;
  let inClass = false;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "\n") return null;
    if (inClass) {
      if (c === "]") inClass = false;
      i++;
      continue;
    }
    if (c === "[") {
      inClass = true;
      i++;
      continue;
    }
    if (c === "/") {
      i++;
      break;
    }
    i++;
  }
  while (i < text.length && /[a-z]/i.test(text[i])) i++;
  return i;
}

// The `//` and `/* */` text of a file, with string literals, template
// literals and regex literals skipped so a warning's own wording, or a `"`
// or `'` inside a regex literal (e.g. `/"/g`), never counts as a comment or
// flips the quote state.
function commentText(text: string): string {
  const comments: string[] = [];
  // A `#!` shebang is not JS/TS syntax; its slashes are not division or a
  // regex start, so it is skipped whole before the tokenizer begins.
  let i = text.startsWith("#!") ? (text.indexOf("\n") === -1 ? text.length : text.indexOf("\n")) : 0;
  let inBlock = false;
  let blockStart = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const c = text[i];
    if (inBlock) {
      if (c === "*" && text[i + 1] === "/") {
        comments.push(text.slice(blockStart, i));
        inBlock = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (quote) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      // `http://`, an escaped slash in a regex literal, and `//` inside one.
      const prev = text[i - 1];
      if (prev === "\\" || prev === "/" || prev === ":") {
        i++;
        continue;
      }
      const newline = text.indexOf("\n", i);
      const end = newline === -1 ? text.length : newline;
      comments.push(text.slice(i + 2, end));
      i = end;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      if (text[i - 1] === "\\") {
        i++;
        continue;
      }
      inBlock = true;
      blockStart = i + 2;
      i += 2;
      continue;
    }
    if (c === "/" && regexLiteralAllowed(text, i)) {
      const end = regexLiteralEnd(text, i);
      if (end !== null) {
        i = end;
        continue;
      }
    }
    i++;
  }
  return comments.join("\n");
}

describe("module ratchets (ADR 0005)", () => {
  it("reads the whole source tree", () => {
    expect(FILES.length).toBeGreaterThan(30);
    expect(FILES).toContain("index.ts");
  });

  it("keeps every file at or under its recorded line cap", () => {
    const observed: Record<string, number> = {};
    for (const rel of FILES) {
      const lines = lineCount(read(rel));
      if (lines > LINE_LIMIT) observed[rel] = lines;
    }
    // A file over the limit with no cap is a new offender; a cap whose file
    // now fits must be deleted. Both surface as a difference in the key set.
    expect(Object.keys(observed).sort()).toEqual(Object.keys(LINE_CAPS).sort());
    const grown = Object.entries(observed)
      .filter(([rel, lines]) => lines > (LINE_CAPS[rel] ?? LINE_LIMIT))
      .map(([rel, lines]) => `${rel}: ${lines} > ${LINE_CAPS[rel] ?? LINE_LIMIT}`);
    expect(grown).toEqual([]);
  });

  it("holds the history-token count of every comment block", () => {
    const observed: Record<string, number> = {};
    for (const rel of FILES) {
      const matches = commentText(read(rel)).match(HISTORY_TOKEN);
      if (matches && matches.length > 0) observed[rel] = matches.length;
    }
    expect(observed).toEqual(COMMENT_TOKENS);
  });

  it("defines each top-level function name in one file", () => {
    const byName = new Map<string, string[]>();
    for (const rel of FILES) {
      for (const match of read(rel).matchAll(TOP_LEVEL_FUNCTION)) {
        const files = byName.get(match[1]) ?? [];
        if (!files.includes(rel)) files.push(rel);
        byName.set(match[1], files);
      }
    }
    const observed: Record<string, string[]> = {};
    for (const [name, files] of [...byName].sort()) {
      if (files.length > 1) observed[name] = [...files].sort();
    }
    expect(observed).toEqual(DUPLICATE_FUNCTIONS);
  });
});
