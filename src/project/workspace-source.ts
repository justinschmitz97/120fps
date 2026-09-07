import fs from "node:fs";
import path from "node:path";
import { isFile, pathKey, toPosix } from "../shared/index.js";
import { declaredPackages, installedPackageDir, readProjectManifest } from "./model.js";
import {
  DECLARATION_FILE,
  type DeclaredEntry,
  exportConditionTargets,
  exportsRootTargets,
  resolveDirectoryEntry,
  resolveTarget,
  SOURCE_EXTENSIONS,
} from "./resolve.js";

// No node_modules segment between the two: a symlink into the monorepo, not a hoisted copy.
export function isWorkspaceSibling(pkgDir: string, workspaceRoot: string): boolean {
  let real: string;
  try {
    real = fs.realpathSync(pkgDir);
  } catch {
    return false;
  }
  const relative = toPosix(path.relative(path.resolve(workspaceRoot), real));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  return !relative.split("/").includes("node_modules");
}

export function declaredRuntimeEntries(manifest: Record<string, unknown>): DeclaredEntry[] {
  const entries: DeclaredEntry[] = [];
  if (typeof manifest.source === "string") entries.push({ field: "source", declared: manifest.source });
  for (const declared of exportsRootTargets(manifest.exports)) {
    entries.push({ field: 'exports["."]', declared });
  }
  if (typeof manifest.module === "string") entries.push({ field: "module", declared: manifest.module });
  if (typeof manifest.main === "string") entries.push({ field: "main", declared: manifest.main });
  return entries;
}

export function declaresRuntimeEntry(manifest: Record<string, unknown> | undefined): boolean {
  if (!manifest) return false;
  return ["source", "exports", "module", "main"].some((field) => manifest[field] !== undefined);
}

// The source sits at the declared path with the build dir dropped: dist/a/i.js -> a/i.ts.
function sourceCandidatesFor(real: string, declared: string): string[] {
  const normalized = toPosix(declared).replace(/^\.\//, "");
  const withoutExtension = (value: string) => value.replace(/\.[^./]+$/, "");
  const relatives = [normalized, withoutExtension(normalized)];
  const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length > 1) {
    const tail = segments.slice(1).join("/");
    relatives.push(withoutExtension(tail), tail);
  }
  // A package that builds flat out of a nested src/ keeps no copy of the entry beside its output.
  for (const relative of [...relatives]) relatives.push(`src/${relative}`);
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const relative of relatives) {
    if (relative.length === 0 || relative === ".." || seen.has(relative)) continue;
    seen.add(relative);
    candidates.push(path.resolve(real, relative));
  }
  return candidates;
}

function resolveSourceCandidate(real: string, declared: string): string | undefined {
  for (const candidate of sourceCandidatesFor(real, declared)) {
    const resolved = resolveTarget(candidate);
    if (resolved !== undefined && !DECLARATION_FILE.test(resolved)) {
      return toPosix(resolved);
    }
  }
  return undefined;
}

type WorkspaceSourceEntry = {
  entry: string;
  field: string;
  declared: string;
  declaredExists: boolean;
};

// `<pkg>/src` is the last fallback, not the only candidate: siblings use any layout.
export function resolveWorkspaceSourceEntry(
  real: string,
  manifest: Record<string, unknown> | undefined,
): WorkspaceSourceEntry | undefined {
  const declaredEntries = manifest ? declaredRuntimeEntries(manifest) : [];
  const declaredExists = (declared: string) => fs.existsSync(path.resolve(real, declared));
  for (const candidate of declaredEntries) {
    const resolved = resolveSourceCandidate(real, candidate.declared);
    if (resolved !== undefined) {
      return {
        entry: resolved,
        field: candidate.field,
        declared: candidate.declared,
        declaredExists: declaredExists(candidate.declared),
      };
    }
  }
  const primary = declaredEntries[0];
  const types = manifest && typeof manifest.types === "string" ? manifest.types : undefined;
  if (types !== undefined && DECLARATION_FILE.test(types)) {
    const stem = path.resolve(real, toPosix(types).replace(DECLARATION_FILE, ""));
    for (const extension of SOURCE_EXTENSIONS) {
      if (!isFile(stem + extension)) continue;
      return {
        entry: toPosix(stem + extension),
        field: "types",
        declared: types,
        declaredExists: declaredExists(types),
      };
    }
  }
  const fallback = resolveTarget(path.join(real, "src"));
  if (fallback === undefined || DECLARATION_FILE.test(fallback)) return undefined;
  return {
    entry: toPosix(fallback),
    field: primary?.field ?? "src",
    declared: primary?.declared ?? "src",
    declaredExists: primary === undefined ? true : declaredExists(primary.declared),
  };
}

// A key whose declared target already resolves needs no source counterpart.
export function workspaceSubpathSourceEntries(
  real: string,
  manifest: Record<string, unknown> | undefined,
): Array<{ subpath: string; entry: string }> {
  const exportsField = manifest?.exports;
  if (!exportsField || typeof exportsField !== "object" || Array.isArray(exportsField)) return [];
  const rescued: Array<{ subpath: string; entry: string }> = [];
  for (const [key, value] of Object.entries(exportsField as Record<string, unknown>)) {
    if (!key.startsWith("./") || key === "./package.json" || key.includes("*")) continue;
    for (const declared of exportConditionTargets(value)) {
      const literal = resolveTarget(path.resolve(real, declared.replace(/^\.\//, "")));
      if (literal !== undefined) break;
      const resolved = resolveSourceCandidate(real, declared);
      if (resolved === undefined || !SOURCE_EXTENSIONS.includes(path.extname(resolved))) continue;
      rescued.push({ subpath: key.slice(2), entry: resolved });
      break;
    }
  }
  return rescued;
}

// `@scope/pkg/sub` is still `@scope/pkg`; `pkg/sub` is still `pkg`.
function siblingPackageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

// The walk asks the same package the same question thousands of times in one run.
const sourcesByPackage = new Map<string, Map<string, string>>();
const pathsByMember = new Map<string, Record<string, string[]> | undefined>();

export function resetWorkspaceSourceCache(): void {
  sourcesByPackage.clear();
  pathsByMember.clear();
}

// Every specifier of one unbuilt sibling that resolves to source: its root, then its subpaths.
function siblingSources(
  pkg: string,
  fromDir: string,
  projectRoot: string,
  workspaceRoot: string,
): Map<string, string> {
  const key = JSON.stringify([
    pathKey(fromDir),
    pathKey(projectRoot),
    pathKey(workspaceRoot),
    pkg,
  ]);
  const cached = sourcesByPackage.get(key);
  if (cached) return cached;
  const sources = new Map<string, string>();
  sourcesByPackage.set(key, sources);

  const dir = installedPackageDir(pkg, fromDir) ?? installedPackageDir(pkg, projectRoot);
  if (dir === undefined || !isWorkspaceSibling(dir, workspaceRoot)) return sources;
  // A sibling whose declared entry is on disk keeps resolving to that entry.
  if (resolveDirectoryEntry(dir) !== undefined) return sources;
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    real = dir;
  }
  const manifest = readProjectManifest(real);
  // A package declaring no runtime entry ships declarations; there is nothing to walk or type.
  if (!declaresRuntimeEntry(manifest)) return sources;
  const source = resolveWorkspaceSourceEntry(real, manifest);
  if (source !== undefined) sources.set(pkg, source.entry);
  // An `exports` subpath of an unbuilt sibling answers from its own source too.
  for (const subpath of workspaceSubpathSourceEntries(real, manifest)) {
    sources.set(`${pkg}/${subpath.subpath}`, subpath.entry);
  }
  return sources;
}

// Undefined for every specifier that is not an unbuilt sibling, third-party imports included.
export function unbuiltSiblingSourceEntry(
  specifier: string,
  importerFile: string,
  projectRoot: string,
  workspaceRoot: string,
): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#")) {
    return undefined;
  }
  const pkg = siblingPackageOf(specifier);
  const sources = siblingSources(pkg, path.dirname(importerFile), projectRoot, workspaceRoot);
  return sources.get(specifier);
}

// The measured package's own dependency list bounds the search; nothing else reaches its types.
export function unbuiltWorkspaceSiblingPaths(
  memberRoot: string,
  workspaceRoot: string,
): Record<string, string[]> | undefined {
  // Outside a workspace there are no siblings, so the common project pays nothing.
  if (pathKey(memberRoot) === pathKey(workspaceRoot)) return undefined;
  const key = JSON.stringify([pathKey(memberRoot), pathKey(workspaceRoot)]);
  if (pathsByMember.has(key)) return pathsByMember.get(key);
  const paths: Record<string, string[]> = {};
  for (const pkg of declaredPackages(memberRoot)) {
    for (const [specifier, entry] of siblingSources(pkg, memberRoot, memberRoot, workspaceRoot)) {
      paths[specifier] = [entry];
    }
  }
  const answer = Object.keys(paths).length > 0 ? paths : undefined;
  pathsByMember.set(key, answer);
  return answer;
}
