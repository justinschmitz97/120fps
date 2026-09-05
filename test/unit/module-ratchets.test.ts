import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ADR 0005 items 3/5: line cap, no history tokens, one function per name; allowlists ratchet.

const SRC = path.resolve("src");
const LINE_LIMIT = 800;

const LINE_CAPS: Record<string, number> = {};

const COMMENT_TOKENS: Record<string, number> = {
};

const DUPLICATE_FUNCTIONS: Record<string, string[]> = {};

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

// A `/` starts a regex only after an operator or keyword, never right after a value.
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

// End index past the regex at `start`, honoring `\` escapes and `[...]`; null if unterminated.
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

// Comment text only: strings, templates and regexes are skipped so their content isn't misread.
function commentText(text: string): string {
  const comments: string[] = [];
  // A `#!` shebang isn't JS syntax; skip it whole so its slashes don't confuse the tokenizer.
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
    // An uncapped file over the limit, or a cap whose file now fits, both show as a key-set diff.
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
