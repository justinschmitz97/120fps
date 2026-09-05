import fs from "node:fs";
import path from "node:path";
import { findWorkspaceRoot } from "../project/index.js";
import { isFile } from "../shared/index.js";

export const ENV_DEFINE_PREFIXES = ["NEXT_PUBLIC_", "VITE_"];
const ENV_FILES = [".env", ".env.local"];
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// KEY=VALUE only: no interpolation, no export semantics, no dotenv dependency.
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = assignment.indexOf("=");
    if (separator <= 0) continue;
    const key = assignment.slice(0, separator).trim();
    if (!ENV_KEY_PATTERN.test(key)) continue;
    let value = assignment.slice(separator + 1).trim();
    const quote = value.charAt(0);
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function readEnvDefines(
  memberRoot: string,
  workspaceRoot: string = findWorkspaceRoot(memberRoot),
): Record<string, string> {
  const levels =
    path.resolve(workspaceRoot) === path.resolve(memberRoot)
      ? [memberRoot]
      : [workspaceRoot, memberRoot];

  const values: Record<string, string> = {};
  for (const level of levels) {
    for (const name of ENV_FILES) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(level, name), "utf-8");
      } catch {
        continue;
      }
      Object.assign(values, parseEnvFile(text));
    }
  }

  // Vite assigns each dotted define onto globalThis; without this, `process` is undefined.
  const defines: Record<string, string> = { "process.env": "{}" };
  for (const [key, value] of Object.entries(values)) {
    // Public prefixes only: a .env also holds database URLs.
    if (!ENV_DEFINE_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    defines[`process.env.${key}`] = JSON.stringify(value);
  }
  return defines;
}

// Answers whether any env file exists, independent of whether it defined a page-visible key.
export function hasAnyEnvFile(
  memberRoot: string,
  workspaceRoot: string = findWorkspaceRoot(memberRoot),
): boolean {
  const levels =
    path.resolve(workspaceRoot) === path.resolve(memberRoot)
      ? [memberRoot]
      : [workspaceRoot, memberRoot];
  for (const level of levels) {
    for (const name of ENV_FILES) {
      if (isFile(path.join(level, name))) return true;
    }
  }
  return false;
}

export const NO_ENV_FILE_REMEDY_NOTE =
  "No .env or .env.local found: 120fps carries a working .env/.env.local injection mechanism, but " +
  `only ${ENV_DEFINE_PREFIXES.join("/")}-prefixed keys reach the page, and the invoking shell's own ` +
  "environment is never read. If this failure is a missing environment variable, add it to a .env " +
  "file at the project or workspace root.";
