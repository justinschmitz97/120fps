import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { findWorkspaceRoot, isPackageDeclared } from "./model.js";
import { toPosix } from "../shared/index.js";

const NUXT_CONFIG_NAMES = [
  "nuxt.config.ts",
  "nuxt.config.mts",
  "nuxt.config.js",
  "nuxt.config.mjs",
  "nuxt.config.cjs",
];

// A repository can carry a nuxt.config without declaring nuxt in the measured member's manifest.
export function isNuxtProject(
  memberRoot: string,
  workspaceRoot: string = findWorkspaceRoot(memberRoot),
): boolean {
  if (isPackageDeclared("nuxt", memberRoot, workspaceRoot)) return true;
  return NUXT_CONFIG_NAMES.some((name) => fs.existsSync(path.join(memberRoot, name)));
}

// The config that names it, and the file `nuxi prepare` was supposed to write.
export interface NuxtPrepareGap {
  config: string;
  missing: string;
}

function declaredConfigPaths(configPath: string): string[] {
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const config = read.config as
    | { extends?: unknown; references?: unknown }
    | undefined;
  if (!config) return [];
  const extended = Array.isArray(config.extends)
    ? config.extends
    : typeof config.extends === "string"
      ? [config.extends]
      : [];
  const referenced = Array.isArray(config.references)
    ? config.references
        .map((entry) => (entry as { path?: unknown })?.path)
        .filter((value): value is string => typeof value === "string")
    : [];
  return [...extended.filter((value): value is string => typeof value === "string"), ...referenced];
}

// A tsconfig may omit .json, and a reference may name the directory holding one.
function configTargetExists(absolute: string): boolean {
  if (fs.existsSync(absolute)) {
    return !fs.statSync(absolute).isDirectory() || fs.existsSync(path.join(absolute, "tsconfig.json"));
  }
  return fs.existsSync(`${absolute}.json`);
}

// Only a generated path: a broken extends outside .nuxt/ stays the tsconfig reader's warning.
export function nuxtPrepareGap(memberRoot: string): NuxtPrepareGap | undefined {
  const configPath = path.join(memberRoot, "tsconfig.json");
  if (!fs.existsSync(configPath)) return undefined;
  for (const declared of declaredConfigPaths(configPath)) {
    const absolute = path.resolve(memberRoot, declared);
    const relative = toPosix(path.relative(memberRoot, absolute));
    if (relative !== ".nuxt" && !relative.startsWith(".nuxt/")) continue;
    if (configTargetExists(absolute)) continue;
    return { config: "tsconfig.json", missing: relative };
  }
  return undefined;
}
