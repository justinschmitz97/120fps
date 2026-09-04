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
  "analysis/explorer.ts": 909,
  "analysis/react-profiler.ts": 902,
  "browser/discovery.ts": 823,
  "cli/main.ts": 1979,
  "pipeline/analyze.ts": 4980,
  "props/values.ts": 822,
  "report/budget.ts": 808,
};

const COMMENT_TOKENS: Record<string, number> = {
  "analysis/compare.ts": 2,
  "analysis/explorer.ts": 21,
  "analysis/isolation.ts": 11,
  "analysis/metrics.ts": 3,
  "analysis/react-profiler.ts": 10,
  "analysis/stress-patterns.ts": 4,
  "browser/discovery.ts": 4,
  "browser/dom.ts": 6,
  "browser/measure.ts": 24,
  "browser/noise.ts": 3,
  "browser/observers.ts": 1,
  "browser/pacing.ts": 2,
  "browser/page-errors.ts": 18,
  "browser/retry.ts": 10,
  "browser/session.ts": 7,
  "browser/settle.ts": 1,
  "browser/trace.ts": 17,
  "cli/main.ts": 63,
  "harness/build.ts": 31,
  "harness/bundler-failure.ts": 13,
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
  "harness/stylesheets.ts": 8,
  "harness/vite-config.ts": 29,
  "harness/workspace-entries.ts": 4,
  "index.ts": 17,
  "pipeline/analyze.ts": 306,
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
  "props/program.ts": 20,
  "props/schema.ts": 6,
  "props/synthesize.ts": 13,
  "props/values.ts": 22,
  "props/vue.ts": 14,
  "report/budget.ts": 25,
  "report/ci.ts": 6,
  "report/hints.ts": 29,
  "report/phases.ts": 4,
  "report/stats.ts": 13,
  "report/terminal-modes.ts": 20,
  "report/terminal.ts": 19,
  "report/types.ts": 51,
};

const DUPLICATE_FUNCTIONS: Record<string, string[]> = {
  componentStem: ["cli/main.ts", "props/candidates.ts"],
  serializeProps: ["analysis/explorer.ts", "analysis/react-profiler.ts", "browser/measure.ts"],
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

// The `//` and `/* */` text of a file, with string and template literals
// skipped so a warning's own wording never counts as a comment.
function commentText(text: string): string {
  const comments: string[] = [];
  let i = 0;
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
