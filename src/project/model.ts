import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { pathKey, readJsonFile, toPosix } from "../shared/index.js";

// A workspace member declares a fraction of what it is built with; the lockfile root has the rest.
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

// Undefined, not an empty manifest: callers that fail closed need "nothing usable here".
export function readProjectManifest(root: string): Record<string, unknown> | undefined {
  const parsed = readJsonFile(path.join(root, MANIFEST));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

function governsInstall(dir: string): boolean {
  if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return true;
  if (WORKSPACE_LOCKFILES.some((name) => fs.existsSync(path.join(dir, name)))) return true;
  return readProjectManifest(dir)?.workspaces !== undefined;
}

// Bounded by the repository: a stray lockfile in a home directory must not claim every project.
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

// Absolute, so two measurements printing the same roots rule out project resolution.
export function formatResolvedRoots(memberRoot: string, workspaceRoot: string): string {
  const member = path.resolve(memberRoot);
  const workspace = path.resolve(workspaceRoot);
  return member === workspace
    ? `Root: ${member}`
    : `Roots: member ${member}, workspace ${workspace}`;
}

// jsconfig.json holds the same JSON shape and the TypeScript config APIs read it.
const COMPILER_CONFIGS = ["tsconfig.json", "jsconfig.json"];

// One answer for alias construction and prop extraction; two searches disagreeing cost aliases.
export function findCompilerConfig(startDir: string, stopDir?: string): string | undefined {
  const stop = stopDir === undefined ? undefined : path.resolve(stopDir);
  let current = path.resolve(startDir);
  while (true) {
    for (const name of COMPILER_CONFIGS) {
      const candidate = path.join(current, name);
      // toPosix: ts.readConfigFile asserts on a backslash path once it has a diagnostic.
      if (fs.existsSync(candidate)) return toPosix(candidate);
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

// A workspaceRoot that is not an ancestor leaves the member as the only level.
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

// Not require.resolve: it honours NODE_PATH and resolves symlinks, losing the level.
function isInstalledAt(level: string, pkg: string): boolean {
  return fs.existsSync(path.join(level, "node_modules", ...pkg.split("/"), MANIFEST));
}

// Separate from availability: a transform that rewrites measured code must be declared.
export function isPackageDeclared(
  pkg: string,
  memberRoot: string,
  workspaceRoot: string = findWorkspaceRoot(memberRoot),
): boolean {
  return declaredPackages(memberRoot).has(pkg) || declaredPackages(workspaceRoot).has(pkg);
}

// Node's CommonJS lookup chain, the reach every createRequire loader here already has.
function isInstalledOnResolutionChain(fromDir: string, pkg: string): boolean {
  let current = path.resolve(fromDir);
  while (true) {
    if (path.basename(current) !== "node_modules" && isInstalledAt(current, pkg)) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

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

// The chain walk is a strict superset of the workspace levels, so no separate probe is needed.
export function isPackageAvailable(
  pkg: string,
  memberRoot: string,
  workspaceRoot: string = findWorkspaceRoot(memberRoot),
): boolean {
  if (isPackageDeclared(pkg, memberRoot, workspaceRoot)) return true;
  return isInstalledOnResolutionChain(memberRoot, pkg);
}

const PNP_MARKERS = [".pnp.cjs", ".pnp.loader.mjs"];

// Every createRequire lookup here assumes real node_modules, so PnP fails deep and unnamed.
export function detectPnP(workspaceRoot: string): boolean {
  // Set by Yarn's own require hook when 120fps itself runs under PnP; markers alone miss that.
  if ((process.versions as Record<string, string | undefined>).pnp !== undefined) return true;
  return PNP_MARKERS.some((name) => fs.existsSync(path.join(workspaceRoot, name)));
}

// npm create vite writes a references-only root; the nearest config there has no paths at all.
export interface GoverningTsconfig {
  // Undefined when there is no config, or the nearest could not be read (caller owns the text).
  configPath: string | undefined;
  nearestConfigPath: string | undefined;
  // True only when configPath came from a `references` entry.
  viaReferences: boolean;
  options: ts.CompilerOptions;
  // Where a relative paths target resolves from: baseUrl, else the declaring config's directory.
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
  // Every config the walk touched, unreadable ones included: a missing target is the case to name.
  const attempted = tried.length > 0 ? `(tried ${tried.join(", ")}) ` : "";
  return (
    `${nearestConfigPath} ${TSCONFIG_REFERENCES_MARKER}; no referenced config covers ${subject} ` +
    `${attempted}so path aliases and compiler options those configs declare are unavailable`
  );
}

// Connects a broken extends chain to the empty prop schema it silently causes.
export function TSCONFIG_EXTENDS_BROKEN_WARNING(tsconfigPath: string, detail: string): string {
  return (
    `${tsconfigPath}: ${detail} Path aliases and compiler options from the broken part of this ` +
    "config chain are unavailable, and prop extraction for files under it may report fewer props " +
    "than the source actually declares."
  );
}

// 5083 and 6053 only: 18003 "No inputs were found" is a normal config, not broken extends.
const EXTENDS_BROKEN_CODES = new Set([5083, 6053]);

// The four options a referenced config supplies that change what a run does.
const GOVERNING_FIELDS = ["paths", "baseUrl", "jsxImportSource", "customConditions"] as const;

interface ReadCompilerConfig {
  raw: Record<string, unknown>;
  parsed: ts.ParsedCommandLine;
  base: string;
  configErrors: string[];
  // TypeScript's own glob expansion, paid for only where coversTarget asks for it.
  fileNames: () => readonly string[];
}

// The include globs are expanded over the whole project; only coversTarget ever reads them.
const NO_DIRECTORY_SCAN: ts.ParseConfigHost = { ...ts.sys, readDirectory: () => [] };

// Keyed by mtime and size, so an edit invalidates the entry and a missing file is never cached.
interface ConfigRead {
  signature: string | undefined;
  failures: string[];
  value: ReadCompilerConfig | undefined;
}

const compilerConfigs = new Map<string, ConfigRead>();
const expandedFileNames = new Map<string, { signature: string | undefined; files: readonly string[] }>();

// The registers span a process, so a test worker must start from empty.
export function resetTsconfigReadCache(): void {
  compilerConfigs.clear();
  expandedFileNames.clear();
}

export function tsconfigSignature(configPath: string): string | undefined {
  try {
    const stat = fs.statSync(configPath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
}

// The caller owns the message, so a failed read pushes detail onto failures and stays quiet.
function readCompilerConfig(
  configPath: string,
  failures: string[],
): ReadCompilerConfig | undefined {
  const key = pathKey(configPath);
  const signature = tsconfigSignature(configPath);
  const cached = compilerConfigs.get(key);
  if (cached && cached.signature === signature) {
    failures.push(...cached.failures);
    return cached.value;
  }
  const own: string[] = [];
  const value = parseCompilerConfig(configPath, own);
  compilerConfigs.set(key, { signature, failures: own, value });
  failures.push(...own);
  return value;
}

function parseCompilerConfig(
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
    // parseJsonConfigFileContent resolves extends, JSONC and trailing commas; baseUrl is absolute.
    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      NO_DIRECTORY_SCAN,
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
      fileNames: () => expandConfigFileNames(configPath, configFile.config),
    };
  } catch (err) {
    failures.push(
      `could not parse tsconfig at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

// TypeScript globs no .vue file on its own, so a config covering an SFC would read as covering
// nothing; the editor tooling a Vue project runs passes the same extension.
const SINGLE_FILE_COMPONENT_EXTENSION: readonly ts.FileExtensionInfo[] = [
  { extension: ".vue", isMixedContent: true, scriptKind: ts.ScriptKind.Deferred },
];

// The real file system, once per config path: only a references walk needs the file list.
function expandConfigFileNames(configPath: string, config: unknown): readonly string[] {
  const key = pathKey(configPath);
  const signature = tsconfigSignature(configPath);
  const cached = expandedFileNames.get(key);
  if (cached && cached.signature === signature) return cached.files;
  let files: readonly string[] = [];
  try {
    files = ts.parseJsonConfigFileContent(
      config,
      ts.sys,
      path.dirname(configPath),
      undefined,
      configPath,
      undefined,
      SINGLE_FILE_COMPONENT_EXTENSION,
    ).fileNames;
  } catch {
    files = [];
  }
  expandedFileNames.set(key, { signature, files });
  return files;
}

// A referenced path is a config file or the directory holding one, as tsc --build reads it.
function resolveReferencePath(configDir: string, reference: string): string | undefined {
  const resolved = path.resolve(configDir, reference);
  try {
    if (fs.statSync(resolved).isDirectory()) {
      return toPosix(path.join(resolved, "tsconfig.json"));
    }
    return toPosix(resolved);
  } catch {
    // A target that is not on disk is still named, so the tried list can report it.
    return resolved.endsWith(".json")
      ? toPosix(resolved)
      : toPosix(path.join(resolved, "tsconfig.json"));
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

// fileNames is TypeScript's own glob result; a directory is covered when any of its files is.
function coversTarget(fileNames: readonly string[], target: string, targetIsFile: boolean): boolean {
  const wanted = pathKey(target);
  const prefix = wanted.endsWith("/") ? wanted : wanted + "/";
  return fileNames.some((file) => {
    const candidate = pathKey(file);
    return targetIsFile ? candidate === wanted : candidate.startsWith(prefix);
  });
}

// Relative to the search root: a monorepo has several tsconfig.json files to tell apart.
function describeNearestConfig(nearestConfigPath: string, stopDir?: string): string {
  if (!stopDir) return path.basename(nearestConfigPath);
  const relative = toPosix(path.relative(stopDir, nearestConfigPath));
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
    // A path that is not on disk is a file when it looks like one.
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

  // A config with its own compilerOptions wins outright, keeping README's "nearest one wins".
  const ownOptions = nearest.raw.compilerOptions;
  const declaresOwnOptions =
    ownOptions !== null &&
    typeof ownOptions === "object" &&
    Object.keys(ownOptions as Record<string, unknown>).length > 0;
  const references = referencePaths(nearest.raw);
  if (declaresOwnOptions || references.length === 0) return nearestAnswer;

  const subject = toPosix(path.relative(path.dirname(nearestConfigPath), target)) || ".";
  const seen = new Set<string>([pathKey(nearestConfigPath)]);
  const tried: string[] = [];
  let queued = references.map((reference) =>
    resolveReferencePath(path.dirname(nearestConfigPath), reference),
  );
  // Breadth-first and cycle-guarded: a root pointing at another root still reaches a project.
  while (queued.length > 0) {
    const next: Array<string | undefined> = [];
    for (const candidate of queued) {
      if (!candidate || seen.has(pathKey(candidate))) continue;
      seen.add(pathKey(candidate));
      const relativeCandidate = toPosix(path.relative(path.dirname(nearestConfigPath), candidate));
      // Named before it is read: an unreadable target is still a config this walk tried.
      const readFailures: string[] = [];
      const referenced = readCompilerConfig(candidate, readFailures);
      if (!referenced) {
        tried.push(`${relativeCandidate} (unreadable)`);
        continue;
      }
      tried.push(relativeCandidate);
      if (!coversTarget(referenced.fileNames(), target, targetIsFile)) {
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
