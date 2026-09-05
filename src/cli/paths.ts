import fs from "node:fs";
import path from "node:path";
import { scanExports } from "../props/index.js";
import { toPosix } from "../shared/index.js";

const SKIP_DIRS = ["node_modules", "dist", "build", ".next", ".120fps-harness-"];
const SKIP_SUFFIX = [".test.", ".spec.", ".stories.", ".fixture."];

export function defaultJsonPathFor(componentPath: string): string {
  const normalized = toPosix(componentPath);
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  const stem = base.replace(/\.[^.]+$/, "");
  return `120fps-report.${stem}.json`;
}

// With many components --json names a prefix; each report gets its component stem appended.
export function resolveReportPaths(
  componentPaths: string[],
  explicitJsonPath?: string,
): string[] {
  if (componentPaths.length === 1 && explicitJsonPath) return [explicitJsonPath];

  const prefix = explicitJsonPath?.replace(/\.json$/, "");
  const seen = new Map<string, number>();
  return componentPaths.map((p) => {
    const base = prefix ? `${prefix}.${reportStem(p)}.json` : defaultJsonPathFor(p);
    // Case-folded: NTFS/APFS collide Card.json with card.json, so both need the suffix branch.
    const key = base.toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    return count === 0 ? base : base.replace(/\.json$/, `-${count + 1}.json`);
  });
}

const JSON_NOTICE_LIST_CAP = 8;

// A CI step passing --json out.json needs to learn it got out.<stem>.json instead.
export function formatJsonSplitNotice(reportPaths: string[]): string {
  if (reportPaths.length < 2) return "";
  const shown = reportPaths.slice(0, JSON_NOTICE_LIST_CAP);
  const rest = reportPaths.length - shown.length;
  const suffix = rest > 0 ? `, +${rest} more` : "";
  return `JSON: ${reportPaths.length} per-component reports: ${shown.join(", ")}${suffix}`;
}

function reportStem(componentPath: string): string {
  const normalized = toPosix(componentPath);
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return base.replace(/\.[^.]+$/, "");
}

export interface PathReader {
  exists: (p: string) => boolean;
  isDirectory: (p: string) => boolean;
  walk: (root: string) => string[];
}

const ACCEPTED_COMPONENT_EXTENSIONS = [".tsx", ".jsx", ".vue", ".ts", ".js"];

// Extension only: an explicitly named path is rejected for its extension, nothing else.
export function hasAcceptedComponentExtension(filePath: string): boolean {
  const posix = toPosix(filePath);
  if (posix.endsWith(".d.ts")) return false;
  return /\.(tsx|jsx|vue|ts|js)$/.test(posix);
}

// A .ts/.js utility with only camelCase exports is not a component; .tsx/.jsx/.vue always are.
export function hasComponentShape(filePath: string): boolean {
  const posix = toPosix(filePath);
  if (/\.(tsx|jsx|vue)$/.test(posix)) return true;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return scanExports(content, filePath).length > 0;
  } catch {
    return false;
  }
}

export function NO_COMPONENT_EXPORT_ERROR(filePath: string): string {
  return `${filePath} has no PascalCase-named export: 120fps could not find a component to measure in this file`;
}

export function isComponentFile(filePath: string): boolean {
  const posix = toPosix(filePath);
  if (!hasAcceptedComponentExtension(posix)) return false;
  for (const segment of posix.split("/")) {
    for (const skip of SKIP_DIRS) {
      if (segment === skip || segment.startsWith(skip)) return false;
    }
  }
  const base = posix.slice(posix.lastIndexOf("/") + 1);
  if (SKIP_SUFFIX.some((s) => base.includes(s))) return false;
  return hasComponentShape(filePath);
}

// `*` stops at a separator, `**` does not; every other regex character is escaped.
function globToRegExp(pattern: string): RegExp {
  const posix = toPosix(pattern);
  let out = "";
  for (let i = 0; i < posix.length; i++) {
    const ch = posix[i];
    if (ch === "*") {
      if (posix[i + 1] === "*") {
        out += ".*";
        i++;
        if (posix[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
      continue;
    }
    out += /[.+?^${}()|[\]\\]/.test(ch) ? "\\" + ch : ch;
  }
  return new RegExp(`^${out}$`);
}

function globRoot(pattern: string): string {
  const posix = toPosix(pattern);
  const star = posix.indexOf("*");
  const cut = posix.lastIndexOf("/", star === -1 ? posix.length : star);
  return cut <= 0 ? "." : posix.slice(0, cut);
}

export function expandComponentPaths(
  args: string[],
  reader: PathReader,
): { paths: string[]; error?: string } {
  const found = new Set<string>();

  for (const arg of args) {
    // Per argument, not the running set: overlapping arguments are a convenience, not an error.
    const matches: string[] = [];

    if (arg.includes("*")) {
      const re = globToRegExp(arg);
      // Absolute pattern: test the walked path as-is; relative: relativize to cwd first.
      const patternIsAbsolute = path.isAbsolute(toPosix(arg));
      for (const file of reader.walk(globRoot(arg))) {
        const target = patternIsAbsolute
          ? toPosix(file)
          : toPosix(path.relative(process.cwd(), file));
        if (re.test(target) && isComponentFile(target)) matches.push(file);
      }
    } else if (reader.exists(arg) && reader.isDirectory(arg)) {
      for (const file of reader.walk(arg)) {
        if (isComponentFile(file)) matches.push(file);
      }
    } else if (reader.exists(arg)) {
      if (!hasAcceptedComponentExtension(arg)) {
        return {
          paths: [],
          error: `${arg} is not a component file: 120fps only measures ${ACCEPTED_COMPONENT_EXTENSIONS.join(", ")} files`,
        };
      }
      if (!hasComponentShape(arg)) {
        return { paths: [], error: NO_COMPONENT_EXPORT_ERROR(arg) };
      }
      matches.push(arg);
    }

    if (matches.length === 0) {
      // An absent plain path deserves the specific message; globs and dirs get the generic one.
      const missingFile = !arg.includes("*") && !reader.exists(arg);
      return {
        paths: [],
        error: missingFile
          ? `File not found: ${arg}`
          : `no component files matched "${arg}"`,
      };
    }
    for (const m of matches) found.add(m);
  }

  return { paths: [...found].sort() };
}

export function nodePathReader(): PathReader {
  const walk = (root: string): string[] => {
    const out: string[] = [];
    const visit = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.some((s) => entry.name === s || entry.name.startsWith(s))) continue;
          visit(full);
        } else if (entry.isFile()) {
          out.push(full);
        }
      }
    };
    visit(path.resolve(root));
    return out;
  };

  return {
    exists: (p) => fs.existsSync(path.resolve(p)),
    isDirectory: (p) => {
      try {
        return fs.statSync(path.resolve(p)).isDirectory();
      } catch {
        return false;
      }
    },
    walk,
  };
}
