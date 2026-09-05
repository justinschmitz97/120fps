// Vite inlines `@import` with its own vendored postcss-import before any configured plugin runs,
// and that inliner deletes an import that follows anything but a comment, another import, `@charset`
// or a body-less `@layer`. Tailwind resolves an import wherever it sits, so a sheet the project's
// own build compiles loses whole theme files here. Moving the statement into the leading import
// block is what the CSS specification already says the browser does with it.

const IMPORT_PREFIX_AT_RULES = new Set(["charset", "layer"]);

// `?raw`, `?url` and `?inline` ask for the file's bytes, not for a compiled stylesheet.
const BYTES_QUERY = /[?&](raw|url|inline)\b/;

interface TopLevelStatement {
  name?: string;
  start: number;
  end: number;
  block: boolean;
}

function skipString(code: string, index: number): number {
  const quote = code[index];
  let i = index + 1;
  while (i < code.length) {
    if (code[i] === "\\") {
      i += 2;
      continue;
    }
    if (code[i] === quote) return i + 1;
    i++;
  }
  return code.length;
}

function skipComment(code: string, index: number): number {
  const end = code.indexOf("*/", index + 2);
  return end < 0 ? code.length : end + 2;
}

// `url(…)` and a variant's selector may hold quotes, braces and semicolons of their own.
function skipParens(code: string, index: number): number {
  let depth = 0;
  let i = index;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "/" && code[i + 1] === "*") {
      i = skipComment(code, i);
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipString(code, i);
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return code.length;
}

function skipTrivia(code: string, index: number): number {
  let i = index;
  while (i < code.length) {
    if (/\s/.test(code[i])) {
      i++;
      continue;
    }
    if (code[i] === "/" && code[i + 1] === "*") {
      i = skipComment(code, i);
      continue;
    }
    return i;
  }
  return code.length;
}

const AT_RULE_NAME = /^@([-\w]+)/;

// Depth zero only: an `@import` inside a block, a comment or a string is not a statement.
function scanTopLevel(code: string): TopLevelStatement[] {
  const statements: TopLevelStatement[] = [];
  let i = 0;
  while (i < code.length) {
    i = skipTrivia(code, i);
    if (i >= code.length) break;
    const start = i;
    const name = code[start] === "@" ? AT_RULE_NAME.exec(code.slice(start))?.[1] : undefined;
    let depth = 0;
    let block = false;
    while (i < code.length) {
      const ch = code[i];
      if (ch === "/" && code[i + 1] === "*") {
        i = skipComment(code, i);
        continue;
      }
      if (ch === '"' || ch === "'") {
        i = skipString(code, i);
        continue;
      }
      if (ch === "(") {
        i = skipParens(code, i);
        continue;
      }
      if (ch === "{") {
        depth++;
        block = true;
        i++;
        continue;
      }
      if (ch === "}") {
        depth--;
        i++;
        if (depth <= 0) break;
        continue;
      }
      if (ch === ";" && depth === 0) {
        i++;
        break;
      }
      i++;
    }
    statements.push({ ...(name !== undefined ? { name } : {}), start, end: i, block });
  }
  return statements;
}

// Undefined when nothing moves, so the caller can leave the module and its source map alone.
export function hoistStylesheetImports(code: string): string | undefined {
  if (!code.includes("@import")) return undefined;
  const statements = scanTopLevel(code);
  let prefixEnd = 0;
  let index = 0;
  for (; index < statements.length; index++) {
    const statement = statements[index];
    if (statement.block) break;
    if (statement.name === "import" || IMPORT_PREFIX_AT_RULES.has(statement.name ?? "")) {
      prefixEnd = statement.end;
      continue;
    }
    break;
  }
  const late = statements
    .slice(index)
    .filter((statement) => statement.name === "import" && !statement.block);
  if (late.length === 0) return undefined;

  let rest = "";
  let cursor = prefixEnd;
  for (const statement of late) {
    rest += code.slice(cursor, statement.start);
    cursor = statement.end;
    // The line the statement occupied goes with it, so no blank line is left behind.
    while (cursor < code.length && (code[cursor] === " " || code[cursor] === "\t")) cursor++;
    if (code[cursor] === "\r") cursor++;
    if (code[cursor] === "\n") cursor++;
  }
  rest += code.slice(cursor);

  const moved = late.map((statement) => code.slice(statement.start, statement.end)).join("\n");
  const head = prefixEnd > 0 ? code.slice(0, prefixEnd) + "\n" : "";
  return head + moved + "\n" + rest;
}

export interface CssImportHoistPlugin {
  name: string;
  enforce: "pre";
  transform: (code: string, id: string) => { code: string; map: null } | null;
}

export function cssImportHoistPlugin(): CssImportHoistPlugin {
  return {
    name: "120fps:hoist-css-imports",
    enforce: "pre",
    transform(code: string, id: string) {
      if (BYTES_QUERY.test(id)) return null;
      if (!id.split("?")[0].toLowerCase().endsWith(".css")) return null;
      const hoisted = hoistStylesheetImports(code);
      return hoisted === undefined ? null : { code: hoisted, map: null };
    },
  };
}
