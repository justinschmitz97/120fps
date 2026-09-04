import fs from "node:fs";
import path from "node:path";
import { findWorkspaceRoot, readProjectManifest, resolveGoverningTsconfig } from "./model.js";
import type { WorkspaceRootAliasSource } from "./tsconfig-aliases.js";
import { isFile, toPosix } from "../shared/index.js";

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

// M109 (A5, react-spectrum-F2): react-aria publishes its subpaths only under
// the `source` condition the consuming tsconfig declares, with no dist/ to fall
// back to, and the dev server answered 500 for every one of them; nothing here
// ever read customConditions. The vite config's own list stays first, so every
// export a project already resolved resolves the same way.
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

// M69: a directory import answers through its manifest before its index file,
// the way node and Vite resolve it.
export function resolveDirectoryEntry(dir: string): string | undefined {
  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
  } catch {
    return undefined;
  }
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

// The root export of an "exports" map, in the order a bundler reads it. Nested
// condition objects are followed one level, which covers { ".": { import: ... } }
// and { ".": { node: { import: ... } } }.
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

// M62: the alias that resolved a bare specifier matters for shim-usage
// reporting, not just where it points: a shim alias redirects a real
// package specifier to a local file, and that specifier is still "imported"
// even though this function treats the result as local. Returning
// viaShimAlias lets the caller record it without this function knowing
// anything about SHIM_MODULES.
// M69: "no alias matched" and "an alias matched and its target is gone" are
// different facts. Collapsing them into null pushed a stale alias into
// optimizeDeps.include as if a package by that name existed.
type LocalResolution =
  | {
      kind: "resolved";
      path: string;
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

// M107 (directus-F1): a package written for NodeNext resolution imports its
// own modules with the extension of the build output (`./parse-now.js`), and
// only the TypeScript source is on disk. Without this the walk stops at the
// first file of an aliased sibling and never sees the siblings that file
// imports. Same mapping TypeScript itself applies, source extensions only.
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

// M76: resolvePackageDir walks the node_modules resolution chain the same way
// isInstalledOnResolutionChain (project-model.ts) does, but returns where a
// package lives instead of whether it does.
export function resolvePackageDir(pkg: string, fromDir: string): string | undefined {
  let current = path.resolve(fromDir);
  while (true) {
    if (path.basename(current) !== "node_modules") {
      const candidate = path.join(current, "node_modules", ...pkg.split("/"));
      if (isFile(path.join(candidate, "package.json"))) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

// M107: the manifest fields that can name a runtime entry, in the order the
// source derivation tries them.
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

// M108 A1 (epic-stack-F1): Node's subpath-imports map, the way Vite reads it.
// The conditions are the browser-development set Vite resolves a dev request
// with; `types` and `node` deliberately absent, `require` last-resort only.
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

// Conditions are declaration-ordered in Node's algorithm: the first key this
// resolver recognises wins, and an array is a fallback list.
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

// The file a "#"-prefixed specifier names, resolved through the `imports` map
// of the importer's OWN package (a workspace member's map, not the measured
// root's). Undefined when no map declares it: that specifier stays unresolved
// and gets the generic missing-subpath diagnosis, never an optimizeDeps entry.
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

// M108 review: an `imports` entry may point at a dependency ("#dep":
// "lodash-es") instead of a file of the package's own. That edge is an
// ordinary external import and belongs in the pre-bundle list; dropped, Vite
// discovers it on the first page load and forces the full reload the
// pre-bundle list exists to prevent.
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
