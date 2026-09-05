import fs from "node:fs";
import path from "node:path";
import {
  DECLARATION_FILE,
  type DeclaredEntry,
  exportConditionTargets,
  exportsRootTargets,
  resolveTarget,
  SOURCE_EXTENSIONS,
} from "../project/index.js";
import { isFile, toPosix } from "../shared/index.js";

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
