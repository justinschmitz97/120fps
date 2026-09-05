import path from "node:path";
import { findWorkspaceRoot, readProjectManifest, resolveGoverningTsconfig } from "./model.js";
import type { WorkspaceRootAliasSource } from "./tsconfig-aliases.js";
import { isFile, readJsonFile, toPosix } from "../shared/index.js";

export function RESOLVE_CONDITIONS_WARNING(
  conditions: string[],
  tsconfigPath: string,
  viteConfigFile?: string,
): string {
  const source = viteConfigFile
    ? `${path.basename(viteConfigFile)}'s resolve.conditions and customConditions in ${tsconfigPath}`
    : `customConditions in ${tsconfigPath}`;
  return `resolve.conditions [${conditions.join(", ")}] came from ${source}.`;
}

// react-aria publishes subpaths only under the source condition its consumer's tsconfig names.
export function resolveServerConditions(
  projectRoot: string,
  viteConditions: string[],
  opts?: { forFile?: string; workspaceRoot?: string; viteConfigFile?: string },
): { conditions: string[]; warning?: string } {
  const governing = resolveGoverningTsconfig(
    opts?.forFile ?? projectRoot,
    opts?.workspaceRoot ?? findWorkspaceRoot(projectRoot),
  );
  const declared = governing.options.customConditions ?? [];
  const added = declared.filter((condition) => !viteConditions.includes(condition));
  // Vite's own list stays first, so every export a project already resolved is unchanged.
  const conditions = [...viteConditions, ...added];
  if (added.length === 0 || !governing.configPath) return { conditions };
  return {
    conditions,
    warning: RESOLVE_CONDITIONS_WARNING(
      conditions,
      governing.configPath,
      viteConditions.length > 0 ? opts?.viteConfigFile : undefined,
    ),
  };
}

// Files worth reading for further imports. A .json or an asset is a leaf.
export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts", ".vue"];
const EXTENSIONS = [...SOURCE_EXTENSIONS, ".json"];

// A manifest answers before an index file, the way node and Vite resolve a directory.
export function resolveDirectoryEntry(dir: string): string | undefined {
  const manifest = readJsonFile(path.join(dir, "package.json"));
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return undefined;
  const fields = manifest as Record<string, unknown>;
  const candidates = [
    conditionalEntry(fields.exports),
    typeof fields.module === "string" ? fields.module : undefined,
    typeof fields.main === "string" ? fields.main : undefined,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = resolveFileWithExtension(path.resolve(dir, candidate));
    if (resolved) return resolved;
  }
  return undefined;
}

// The root export of an exports map, in the order a bundler reads its conditions.
function conditionalEntry(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value) || depth > 2) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const root = depth === 0 && "." in record ? record["."] : record;
  if (typeof root === "string") return root;
  if (typeof root !== "object" || root === null) return undefined;
  for (const condition of ["import", "module", "browser", "default", "require"]) {
    const entry = (root as Record<string, unknown>)[condition];
    const resolved = conditionalEntry(entry, depth + 1);
    if (resolved) return resolved;
  }
  return undefined;
}

function resolveFileWithExtension(target: string): string | undefined {
  if (isFile(target)) return target;
  for (const ext of EXTENSIONS) {
    if (isFile(target + ext)) return target + ext;
  }
  return undefined;
}

export function resolveTarget(target: string): string | undefined {
  const direct = resolveFileWithExtension(target);
  if (direct) return direct;
  const fromManifest = resolveDirectoryEntry(target);
  if (fromManifest) return fromManifest;
  for (const ext of EXTENSIONS) {
    const indexFile = path.join(target, "index" + ext);
    if (isFile(indexFile)) return indexFile;
  }
  return undefined;
}

// Collapsing "no alias" and "alias target gone" would push a ghost package into optimizeDeps.
type LocalResolution =
  | {
      kind: "resolved";
      path: string;
      // The caller records a shim-aliased specifier as imported, though it resolves local.
      viaShimAlias: boolean;
      viaWorkspaceRootAlias?: WorkspaceRootAliasSource;
    }
  | {
      kind: "alias-miss";
      target: string;
      viaShimAlias: boolean;
      viaWorkspaceRootAlias?: WorkspaceRootAliasSource;
    }
  | { kind: "unaliased" };

// A NodeNext package imports ./x.js while only the TypeScript source is on disk.
const TS_COUNTERPARTS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
  ".jsx": [".tsx"],
};

function resolveTypeScriptCounterpart(target: string): string | undefined {
  const extension = path.extname(target);
  const counterparts = TS_COUNTERPARTS[extension];
  if (counterparts === undefined) return undefined;
  const stem = target.slice(0, target.length - extension.length);
  for (const counterpart of counterparts) {
    if (isFile(stem + counterpart)) return stem + counterpart;
  }
  return undefined;
}

export function resolveLocalImport(
  fromFile: string,
  spec: string,
  projectRoot: string,
  aliases: Array<{
    find: RegExp;
    replacement: string;
    isShim?: boolean;
    fromWorkspaceRoot?: WorkspaceRootAliasSource;
  }>,
): LocalResolution {
  let target: string;
  let viaShimAlias = false;
  let viaWorkspaceRootAlias: WorkspaceRootAliasSource | undefined;
  let aliased = false;
  if (spec.startsWith(".") || spec.startsWith("/")) {
    target = path.resolve(path.dirname(fromFile), spec);
  } else {
    let aliasedPath: string | undefined;
    for (const { find, replacement, isShim, fromWorkspaceRoot } of aliases) {
      if (find.test(spec)) {
        aliasedPath = spec.replace(find, replacement);
        viaShimAlias = isShim === true;
        viaWorkspaceRootAlias = fromWorkspaceRoot;
        break;
      }
    }
    if (aliasedPath === undefined) return { kind: "unaliased" };
    aliased = true;
    target = path.isAbsolute(aliasedPath) ? aliasedPath : path.resolve(projectRoot, aliasedPath);
  }

  const resolved = resolveTarget(target) ?? resolveTypeScriptCounterpart(target);
  if (resolved) return { kind: "resolved", path: resolved, viaShimAlias, viaWorkspaceRootAlias };
  if (!aliased) return { kind: "unaliased" };
  return {
    kind: "alias-miss",
    target: toPosix(target),
    viaShimAlias,
    viaWorkspaceRootAlias,
  };
}

// The manifest field that named a runtime entry, and the raw value it declared.
export type DeclaredEntry = { field: string; declared: string };

const EXPORT_ENTRY_CONDITIONS = ["development", "source", "import", "default", "require"];

export const DECLARATION_FILE = /\.d\.[cm]?ts$/;

export function exportConditionTargets(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object" || Array.isArray(value) || depth > 2) return [];
  const record = value as Record<string, unknown>;
  const targets: string[] = [];
  for (const condition of EXPORT_ENTRY_CONDITIONS) {
    if (!(condition in record)) continue;
    for (const target of exportConditionTargets(record[condition], depth + 1)) {
      if (!targets.includes(target)) targets.push(target);
    }
  }
  return targets;
}

export function exportsRootTargets(exportsField: unknown): string[] {
  if (typeof exportsField === "string") return [exportsField];
  if (exportsField === null || typeof exportsField !== "object" || Array.isArray(exportsField)) {
    return [];
  }
  const record = exportsField as Record<string, unknown>;
  if ("." in record) return exportConditionTargets(record["."]);
  // A sugar form: conditions at the top level, no subpath keys at all.
  if (Object.keys(record).some((key) => key.startsWith("."))) return [];
  return exportConditionTargets(record);
}

// Vite's browser-development set: types and node deliberately absent, require last.
const SUBPATH_IMPORT_CONDITIONS = [
  "source",
  "development",
  "browser",
  "module",
  "import",
  "require",
  "default",
];

function nearestManifestDir(fromDir: string): string | undefined {
  let dir = path.resolve(fromDir);
  for (;;) {
    if (isFile(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// Declaration order decides in Node's algorithm; an array is a fallback list.
function pickConditionalTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const picked = pickConditionalTarget(entry);
      if (picked) return picked;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const [condition, nested] of Object.entries(value as Record<string, unknown>)) {
      if (!SUBPATH_IMPORT_CONDITIONS.includes(condition)) continue;
      const picked = pickConditionalTarget(nested);
      if (picked) return picked;
    }
  }
  return undefined;
}

// The importer's OWN package map, not the measured root's: a workspace member has its own.
function pickSubpathImportTarget(
  importerFile: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith("#")) return undefined;
  const pkgDir = nearestManifestDir(path.dirname(importerFile));
  if (!pkgDir) return undefined;
  const manifest = readProjectManifest(pkgDir);
  const imports = manifest?.imports;
  if (!imports || typeof imports !== "object") return undefined;

  const entries = Object.entries(imports as Record<string, unknown>);
  let target = entries.find(([key]) => key === specifier)?.[1];
  let substitution: string | undefined;
  if (target === undefined) {
    // Longest matching prefix wins, as Node's PATTERN_KEY_COMPARE does.
    let bestPrefix = "";
    for (const [key, value] of entries) {
      const star = key.indexOf("*");
      if (star < 0) continue;
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
      if (specifier.length < prefix.length + suffix.length) continue;
      if (prefix.length < bestPrefix.length) continue;
      bestPrefix = prefix;
      target = value;
      substitution = specifier.slice(prefix.length, specifier.length - suffix.length);
    }
  }

  const picked = pickConditionalTarget(target);
  if (!picked) return undefined;
  const filled = substitution === undefined ? picked : picked.split("*").join(substitution);
  return picked.startsWith(".") ? path.resolve(pkgDir, filled) : filled;
}

export function resolveSubpathImport(
  importerFile: string,
  specifier: string,
): string | undefined {
  const target = pickSubpathImportTarget(importerFile, specifier);
  if (!target || !path.isAbsolute(target)) return undefined;
  return resolveTarget(target);
}

// An imports entry may name a dependency; dropped, Vite full-reloads on first page load.
export function subpathImportPackage(
  importerFile: string,
  specifier: string,
): string | undefined {
  const target = pickSubpathImportTarget(importerFile, specifier);
  if (!target || path.isAbsolute(target) || target.startsWith(".") || target.startsWith("#")) {
    return undefined;
  }
  return target;
}
