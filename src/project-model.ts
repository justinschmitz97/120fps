import fs from "node:fs";
import path from "node:path";

// M68. One directory used to answer every question about a project, which is
// only right when the package and the install are the same directory. A
// workspace member declares a fraction of what it is built with: the rest lives
// at the root that owns the lockfile.
export interface ProjectModel {
  // Nearest ancestor with a package.json: harness dir, Vite root, baseline key.
  memberRoot: string;
  // The root that governs the install. Equal to memberRoot outside a workspace.
  workspaceRoot: string;
}

const MANIFEST = "package.json";

export const WORKSPACE_LOCKFILES = ["pnpm-lock.yaml", "yarn.lock", "package-lock.json"];

export function findProjectRoot(dir: string): string | undefined {
  let current = dir;
  while (true) {
    if (fs.existsSync(path.join(current, MANIFEST))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

// Undefined means "nothing usable here": missing, unparsable, or a JSON value
// that is not an object. Callers that must fail closed need that distinction,
// so it is not collapsed into an empty manifest.
export function readProjectManifest(root: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function governsInstall(dir: string): boolean {
  if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return true;
  if (WORKSPACE_LOCKFILES.some((name) => fs.existsSync(path.join(dir, name)))) return true;
  return readProjectManifest(dir)?.workspaces !== undefined;
}

// Nearest wins, and the walk never leaves the repository the member is in: an
// unbounded walk would let one stray lockfile in a home directory claim every
// project underneath it.
export function findWorkspaceRoot(memberRoot: string): string {
  let current = memberRoot;
  while (true) {
    if (governsInstall(current)) return current;
    if (fs.existsSync(path.join(current, ".git"))) return memberRoot;
    const parent = path.dirname(current);
    if (parent === current) return memberRoot;
    current = parent;
  }
}

export function resolveProjectModel(dir: string): ProjectModel {
  const memberRoot = findProjectRoot(dir) ?? dir;
  return { memberRoot, workspaceRoot: findWorkspaceRoot(memberRoot) };
}

const COMPILER_CONFIGS = ["tsconfig.json", "jsconfig.json"];

// M69. One answer to "which config governs this file", shared by alias
// construction and prop extraction: two searches that disagreed gave a
// workspace member working prop types and zero aliases. jsconfig.json holds the
// same JSON shape and the TypeScript config APIs read it, so a JavaScript
// project is not a separate path. The nearest level wins, and the walk stops
// after stopDir; without a stopDir it reaches the filesystem root, which is the
// reach ts.findConfigFile had. Forward slashes, because ts.readConfigFile
// asserts on a backslash path once it has a diagnostic to report.
export function findCompilerConfig(startDir: string, stopDir?: string): string | undefined {
  const stop = stopDir === undefined ? undefined : path.resolve(stopDir);
  let current = path.resolve(startDir);
  while (true) {
    for (const name of COMPILER_CONFIGS) {
      const candidate = path.join(current, name);
      if (fs.existsSync(candidate)) return candidate.replace(/\\/g, "/");
    }
    if (current === stop) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "peerDependencies"];

export function declaredPackages(root: string): Set<string> {
  const names = new Set<string>();
  const manifest = readProjectManifest(root);
  if (!manifest) return names;
  for (const field of DEPENDENCY_SECTIONS) {
    const section = manifest[field];
    if (!section || typeof section !== "object" || Array.isArray(section)) continue;
    for (const name of Object.keys(section as Record<string, unknown>)) names.add(name);
  }
  return names;
}

// memberRoot first, then each ancestor up to and including workspaceRoot. A
// workspaceRoot that is not an ancestor leaves the member as the only level.
export function workspaceLevels(memberRoot: string, workspaceRoot: string): string[] {
  const target = path.resolve(workspaceRoot);
  const levels: string[] = [memberRoot];
  let current = path.resolve(memberRoot);
  while (current !== target) {
    const parent = path.dirname(current);
    if (parent === current) return [memberRoot];
    levels.push(parent);
    current = parent;
  }
  return levels;
}

// A hoisting installer puts a package at a level no manifest mentions, which is
// how a member with an empty manifest still builds. require.resolve is not the
// probe: it honours NODE_PATH (a test runner points it at pnpm's store, where
// everything resolves from everywhere) and it resolves symlinks, so a member's
// link answers with a store path that no longer names the level it came from.
function isInstalledAt(level: string, pkg: string): boolean {
  return fs.existsSync(path.join(level, "node_modules", ...pkg.split("/"), MANIFEST));
}

// Declaration at either level. Separate from availability because a transform
// that rewrites the measured code (M27's React Compiler) must be something the
// project says it ships: a hoisted transitive copy is not evidence of that.
export function isPackageDeclared(
  pkg: string,
  memberRoot: string,
  workspaceRoot: string = findWorkspaceRoot(memberRoot),
): boolean {
  return declaredPackages(memberRoot).has(pkg) || declaredPackages(workspaceRoot).has(pkg);
}

export function isPackageAvailable(
  pkg: string,
  memberRoot: string,
  workspaceRoot: string = findWorkspaceRoot(memberRoot),
): boolean {
  if (isPackageDeclared(pkg, memberRoot, workspaceRoot)) return true;
  return workspaceLevels(memberRoot, workspaceRoot).some((level) => isInstalledAt(level, pkg));
}
