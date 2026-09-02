import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

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

// M75. Node's own CommonJS lookup chain: the directory, then every ancestor to
// the filesystem root, skipping a `node_modules` directory as a base the way
// Module._nodeModulePaths does. This is the reach every loader in this codebase
// already has, all of them resolving through `createRequire(path.join(root, "/"))`,
// so a package installed above the workspace root is importable and the
// per-level walk (memberRoot up to workspaceRoot) reported it absent.
//
// Still a directory probe rather than require.resolve, for two measured reasons:
// pnpm exports NODE_PATH into its hoisted store for every script it runs, so
// under `pnpm test` every package resolves from every directory; and
// `<pkg>/package.json` is answered through the package's `exports` map, which
// @vitejs/plugin-vue does not open.
function isInstalledOnResolutionChain(fromDir: string, pkg: string): boolean {
  let current = path.resolve(fromDir);
  while (true) {
    if (path.basename(current) !== "node_modules" && isInstalledAt(current, pkg)) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

// M77. The same upward walk as isInstalledOnResolutionChain, but returns
// where a package lives instead of whether it does, so a caller can inspect
// what is actually installed there (e.g. whether it has a runtime entry at
// all, as distinct from a type-only import TypeScript resolves but a bundler
// cannot load).
export function installedPackageDir(pkg: string, fromDir: string): string | undefined {
  let current = path.resolve(fromDir);
  while (true) {
    if (path.basename(current) !== "node_modules" && isInstalledAt(current, pkg)) {
      return path.join(current, "node_modules", ...pkg.split("/"));
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

// The chain walk is a strict superset of the workspace levels: every level is
// memberRoot or one of its ancestors, so it needs no separate probe.
export function isPackageAvailable(
  pkg: string,
  memberRoot: string,
  workspaceRoot: string = findWorkspaceRoot(memberRoot),
): boolean {
  if (isPackageDeclared(pkg, memberRoot, workspaceRoot)) return true;
  return isInstalledOnResolutionChain(memberRoot, pkg);
}

const PNP_MARKERS = [".pnp.cjs", ".pnp.loader.mjs"];

// M72. Yarn PnP replaces node_modules with a virtual filesystem resolved by
// these two loader files at the workspace root; the harness's Vite server and
// every createRequire-based lookup in this codebase assume real node_modules,
// so a PnP install fails deep and confusingly instead of naming the actual
// cause. process.versions.pnp is set by Yarn's own require hook when 120fps
// itself runs under PnP, which the marker-file probe alone would miss.
export function detectPnP(workspaceRoot: string): boolean {
  if ((process.versions as Record<string, string | undefined>).pnp !== undefined) return true;
  return PNP_MARKERS.some((name) => fs.existsSync(path.join(workspaceRoot, name)));
}

// M109 (I1, coordinator-F1): "which config governs this file" has one more
// answer than `findCompilerConfig` gives. `npm create vite@latest` writes a
// root that declares no compilerOptions at all -- `{ "files": [],
// "references": [...] }` -- and puts every option the project uses in
// `tsconfig.app.json`. TypeScript reads the referenced project that covers the
// file; the harness and prop extraction read the nearest config, found no
// `paths`, and the run died on the project's own `@/lib/utils` import.
export interface GoverningTsconfig {
  // The config whose options apply. Undefined only when there is no config, or
  // when the nearest one could not be read (the caller owns that message).
  configPath: string | undefined;
  nearestConfigPath: string | undefined;
  // True only when configPath came from a `references` entry.
  viaReferences: boolean;
  options: ts.CompilerOptions;
  // Where a relative `paths` target resolves from: baseUrl, else the directory
  // of the config that declared `paths`, else the config's own directory.
  base: string;
  warnings: string[];
}

// The wording the harness prints, and the text its disclosure register keys on.
export const TSCONFIG_REFERENCES_MARKER = "declares no compilerOptions and lists references";

export function TSCONFIG_REFERENCES_WARNING(
  nearestConfigPath: string,
  chosenConfigPath: string,
  subject: string,
  fields: string[],
): string {
  const supplied = fields.length > 0 ? fields.join(", ") : "its compiler options";
  return (
    `${nearestConfigPath} ${TSCONFIG_REFERENCES_MARKER}; ${chosenConfigPath} covers ${subject} ` +
    `and supplies ${supplied}`
  );
}

export function TSCONFIG_REFERENCES_NO_MATCH_WARNING(
  nearestConfigPath: string,
  subject: string,
  tried: string[],
): string {
  // Every config the walk touched, including one it could not read: a
  // reference target that is missing is exactly the case this sentence has to
  // explain, so naming nothing there would be the unhelpful answer.
  const attempted = tried.length > 0 ? `(tried ${tried.join(", ")}) ` : "";
  return (
    `${nearestConfigPath} ${TSCONFIG_REFERENCES_MARKER}; no referenced config covers ${subject} ` +
    `${attempted}so path aliases and compiler options those configs declare are unavailable`
  );
}

// M95 (nuxt-ui-F1/F2): a broken extends chain, named and connected to the
// downstream consequence (an empty prop schema) it silently causes, instead
// of two unrelated-looking facts a user has to connect themselves. M109 moved
// it here from `src/harness.ts`, which re-exports it, so that the one reader
// can produce it.
export function TSCONFIG_EXTENDS_BROKEN_WARNING(tsconfigPath: string, detail: string): string {
  return (
    `${tsconfigPath}: ${detail} Path aliases and compiler options from the broken part of this ` +
    "config chain are unavailable, and prop extraction for files under it may report fewer props " +
    "than the source actually declares."
  );
}

// M95: scoped to the two diagnostic codes TypeScript actually uses for an
// unresolvable extends target (5083 "Cannot find a base configuration file",
// 6053 "File not found"). Every other parseJsonConfigFileContent diagnostic is
// unrelated noise -- 18003 "No inputs were found" fires for a tmpdir tsconfig
// with no matching source files, which is a completely normal config.
const EXTENDS_BROKEN_CODES = new Set([5083, 6053]);

// The four options a referenced config supplies that change what a run does.
const GOVERNING_FIELDS = ["paths", "baseUrl", "jsxImportSource", "customConditions"] as const;

interface ReadCompilerConfig {
  raw: Record<string, unknown>;
  parsed: ts.ParsedCommandLine;
  base: string;
  configErrors: string[];
}

// Returns undefined on a read or parse failure, with the detail pushed onto
// `failures`: the caller owns the message, so no read reports itself twice.
function readCompilerConfig(
  configPath: string,
  failures: string[],
): ReadCompilerConfig | undefined {
  const configDir = path.dirname(configPath);
  try {
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (configFile.error) {
      failures.push(
        `could not parse tsconfig at ${configPath}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, " ")}`,
      );
      return undefined;
    }
    // parseJsonConfigFileContent resolves extends (string and array), JSONC and
    // trailing commas; baseUrl comes back absolute.
    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      configDir,
      undefined,
      configPath,
    );
    const options = parsed.options;
    const base =
      options.baseUrl ?? (options as { pathsBasePath?: string }).pathsBasePath ?? configDir;
    return {
      raw: (configFile.config ?? {}) as Record<string, unknown>,
      parsed,
      base,
      configErrors: parsed.errors
        .filter((d) => EXTENDS_BROKEN_CODES.has(d.code))
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")),
    };
  } catch (err) {
    failures.push(
      `could not parse tsconfig at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

function normalisePath(file: string): string {
  const forward = path.resolve(file).replace(/\\/g, "/");
  return process.platform === "win32" ? forward.toLowerCase() : forward;
}

// A referenced `path` is a config file or the directory holding one, exactly as
// `tsc --build` reads it.
function resolveReferencePath(configDir: string, reference: string): string | undefined {
  const resolved = path.resolve(configDir, reference);
  try {
    if (fs.statSync(resolved).isDirectory()) {
      return path.join(resolved, "tsconfig.json").replace(/\\/g, "/");
    }
    return resolved.replace(/\\/g, "/");
  } catch {
    // A target that is not on disk is still named: a ".json" target reaches
    // readCompilerConfig as itself, a directory target as the "tsconfig.json"
    // `tsc --build` looks for inside it, so the tried list names both.
    return resolved.endsWith(".json")
      ? resolved.replace(/\\/g, "/")
      : path.join(resolved, "tsconfig.json").replace(/\\/g, "/");
  }
}

function referencePaths(raw: Record<string, unknown>): string[] {
  const references = raw.references;
  if (!Array.isArray(references)) return [];
  return references
    .map((entry) =>
      entry && typeof entry === "object" ? (entry as { path?: unknown }).path : undefined,
    )
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

// `include`/`files` semantics, computed by TypeScript itself: fileNames is the
// glob result. A directory is covered when any of its files is.
function coversTarget(fileNames: readonly string[], target: string, targetIsFile: boolean): boolean {
  const wanted = normalisePath(target);
  const prefix = wanted.endsWith("/") ? wanted : wanted + "/";
  return fileNames.some((file) => {
    const candidate = normalisePath(file);
    return targetIsFile ? candidate === wanted : candidate.startsWith(prefix);
  });
}

// A monorepo member's nearest config is one of several tsconfig.json files in
// the tree, so the disclosure names it relative to the root that bounded the
// search. A single-package project, whose search root holds that config, still
// reads as a bare "tsconfig.json".
function describeNearestConfig(nearestConfigPath: string, stopDir?: string): string {
  if (!stopDir) return path.basename(nearestConfigPath);
  const relative = path.relative(stopDir, nearestConfigPath).replace(/\\/g, "/");
  return relative.length > 0 && !relative.startsWith("..")
    ? relative
    : path.basename(nearestConfigPath);
}

export function resolveGoverningTsconfig(fileOrDir: string, stopDir?: string): GoverningTsconfig {
  const target = path.resolve(fileOrDir);
  let targetIsFile = false;
  try {
    targetIsFile = !fs.statSync(target).isDirectory();
  } catch {
    // A path that is not on disk is a file when it looks like one; a caller
    // naming a directory that does not exist gets the same answer either way.
    targetIsFile = path.extname(target) !== "";
  }
  const startDir = targetIsFile ? path.dirname(target) : target;
  const warnings: string[] = [];
  const nearestConfigPath = findCompilerConfig(startDir, stopDir);
  if (!nearestConfigPath) {
    return {
      configPath: undefined,
      nearestConfigPath: undefined,
      viaReferences: false,
      options: {},
      base: startDir,
      warnings,
    };
  }

  const nearest = readCompilerConfig(nearestConfigPath, warnings);
  if (!nearest) {
    return {
      configPath: undefined,
      nearestConfigPath,
      viaReferences: false,
      options: {},
      base: startDir,
      warnings,
    };
  }
  for (const detail of nearest.configErrors) {
    warnings.push(TSCONFIG_EXTENDS_BROKEN_WARNING(nearestConfigPath, detail));
  }
  const nearestAnswer: GoverningTsconfig = {
    configPath: nearestConfigPath,
    nearestConfigPath,
    viaReferences: false,
    options: nearest.parsed.options,
    base: nearest.base,
    warnings,
  };

  // MUST NOT: a config declaring its own compilerOptions wins outright, so the
  // README's "nearest one wins" stays true for every project that has one.
  const ownOptions = nearest.raw.compilerOptions;
  const declaresOwnOptions =
    ownOptions !== null &&
    typeof ownOptions === "object" &&
    Object.keys(ownOptions as Record<string, unknown>).length > 0;
  const references = referencePaths(nearest.raw);
  if (declaresOwnOptions || references.length === 0) return nearestAnswer;

  const subject = path.relative(path.dirname(nearestConfigPath), target).replace(/\\/g, "/") || ".";
  const seen = new Set<string>([normalisePath(nearestConfigPath)]);
  const tried: string[] = [];
  let queued = references.map((reference) =>
    resolveReferencePath(path.dirname(nearestConfigPath), reference),
  );
  // Breadth-first over the reference graph, cycle-guarded: a solution-style
  // root pointing at another solution-style root still reaches a real project,
  // and a cycle or a missing target ends the walk with the nearest config.
  while (queued.length > 0) {
    const next: Array<string | undefined> = [];
    for (const candidate of queued) {
      if (!candidate || seen.has(normalisePath(candidate))) continue;
      seen.add(normalisePath(candidate));
      const relativeCandidate = path
        .relative(path.dirname(nearestConfigPath), candidate)
        .replace(/\\/g, "/");
      // Named before it is read: a missing or malformed reference target is a
      // config this walk tried, and A2's no-match sentence names every one.
      const readFailures: string[] = [];
      const referenced = readCompilerConfig(candidate, readFailures);
      if (!referenced) {
        tried.push(`${relativeCandidate} (unreadable)`);
        continue;
      }
      tried.push(relativeCandidate);
      if (!coversTarget(referenced.parsed.fileNames, target, targetIsFile)) {
        for (const nested of referencePaths(referenced.raw)) {
          next.push(resolveReferencePath(path.dirname(candidate), nested));
        }
        continue;
      }
      for (const detail of referenced.configErrors) {
        warnings.push(TSCONFIG_EXTENDS_BROKEN_WARNING(candidate, detail));
      }
      const supplied = GOVERNING_FIELDS.filter(
        (field) => (referenced.parsed.options as Record<string, unknown>)[field] !== undefined,
      );
      warnings.push(
        TSCONFIG_REFERENCES_WARNING(
          describeNearestConfig(nearestConfigPath, stopDir),
          relativeCandidate,
          subject,
          [...supplied],
        ),
      );
      return {
        configPath: candidate,
        nearestConfigPath,
        viaReferences: true,
        options: referenced.parsed.options,
        base: referenced.base,
        warnings,
      };
    }
    queued = next;
  }

  warnings.push(
    TSCONFIG_REFERENCES_NO_MATCH_WARNING(
      describeNearestConfig(nearestConfigPath, stopDir),
      subject,
      tried,
    ),
  );
  return nearestAnswer;
}
