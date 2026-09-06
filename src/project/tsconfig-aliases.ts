import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  findCompilerConfig,
  findWorkspaceRoot,
  isPackageAvailable,
  resolveGoverningTsconfig,
  TSCONFIG_EXTENDS_BROKEN_WARNING,
  TSCONFIG_REFERENCES_MARKER,
} from "./model.js";
import { resolveTarget, SOURCE_EXTENSIONS } from "./resolve.js";
import { escapeRegex, pathKey, toPosix } from "../shared/index.js";

function countStars(s: string): number {
  return (s.match(/\*/g) ?? []).length;
}

// A mismatched entry builds a regex that can never match, so the absent alias is disclosed.
export function ALIAS_SHAPE_WARNING(pattern: string, target: string): string {
  const patternStars = countStars(pattern);
  const targetStars = countStars(target);
  const reason =
    patternStars === targetStars
      ? `both sides carry ${patternStars} wildcards, which is not a shape a single alias can express`
      : `the pattern has ${patternStars} wildcard${patternStars === 1 ? "" : "s"} and the target has ${targetStars}`;
  return (
    `tsconfig path alias "${pattern}" -> "${target}": ${reason}, so no alias was built and imports ` +
    "matching that pattern will not resolve"
  );
}

// A placeholder survives one path.resolve, so the target's * can sit anywhere in the string.
const WILDCARD_ALIAS_PLACEHOLDER = "__120fpsSTAR__";

// Vite's @rollup/plugin-alias substitutes $1 from the capture group.
function buildWildcardCaptureAlias(
  pattern: string,
  target: string,
  base: string,
): { find: RegExp; replacement: string } {
  const [patternPrefix, patternSuffix] = pattern.split("*");
  const resolvedAbs = toPosix(path.resolve(base, target.replace("*", WILDCARD_ALIAS_PLACEHOLDER)));
  const starIndex = resolvedAbs.indexOf(WILDCARD_ALIAS_PLACEHOLDER);
  const absPrefix = resolvedAbs.slice(0, starIndex);
  const absSuffix = resolvedAbs.slice(starIndex + WILDCARD_ALIAS_PLACEHOLDER.length);
  return {
    find: new RegExp(`^${escapeRegex(patternPrefix)}(.*)${escapeRegex(patternSuffix)}$`),
    replacement: `${absPrefix}$1${absSuffix}`,
  };
}

// baseUrl with no paths: every top-level entry is an alias, unless node resolution owns it.
function baseUrlAliases(
  baseUrl: string,
  memberRoot: string,
  workspaceRoot: string,
): TsconfigAlias[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseUrl, { withFileTypes: true });
  } catch {
    return [];
  }
  const aliases: TsconfigAlias[] = [];
  const claimed = new Set<string>();
  // A file wins over a directory of the same name, as in node resolution.
  const ordered = [...entries.filter((e) => e.isFile()), ...entries.filter((e) => e.isDirectory())];
  for (const entry of ordered) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const isDirectory = entry.isDirectory();
    const extension = path.extname(entry.name);
    if (!isDirectory && !SOURCE_EXTENSIONS.includes(extension)) continue;
    const name = isDirectory ? entry.name : entry.name.slice(0, -extension.length);
    if (!name || claimed.has(name)) continue;
    if (isPackageAvailable(name, memberRoot, workspaceRoot)) continue;
    claimed.add(name);
    aliases.push({
      // A directory answers for everything under it; a file for its own name alone.
      find: new RegExp(`^${escapeRegex(name)}${isDirectory ? "(?=/|$)" : "$"}`),
      replacement: toPosix(path.resolve(baseUrl, entry.name)),
      pattern: name,
      target: entry.name,
    });
  }
  return aliases;
}

// A stale-alias report names the key and the target the project declared, not the built regex.
export interface TsconfigAlias {
  find: RegExp;
  replacement: string;
  pattern?: string;
  target?: string;
  fromWorkspaceRoot?: WorkspaceRootAliasSource;
}

// Tags an alias built from the workspace root, which WORKSPACE_ROOT_ALIAS_WARNING discloses.
export interface WorkspaceRootAliasSource {
  pattern: string;
  target: string;
  configFile: string;
}

export function WORKSPACE_ROOT_ALIAS_WARNING(
  specifier: string,
  pattern: string,
  target: string,
  configFile: string,
): string {
  return (
    `import "${specifier}" resolved through the workspace root's tsconfig path alias "${pattern}" -> ` +
    `"${target}" (${configFile}), which the component's own package does not declare`
  );
}

// A .d.ts-only target would become an inert alias that crashes the harness on first import.
export function TYPES_ONLY_ALIAS_WARNING(pattern: string, target: string): string {
  return (
    `tsconfig path alias "${pattern}" -> "${target}" resolves to a location with no runtime entry ` +
    "(no package.json main/module/exports, no index file); the alias was skipped and " +
    `"${pattern}" resolves through normal node resolution instead`
  );
}

// Slashes are stripped: a leading one makes a root-absolute URL, not a constraint on the path.
export function capturesEveryRootAbsoluteUrl(pattern: string): boolean {
  const first = pattern.indexOf("*");
  if (first === -1) return false;
  const bare = (part: string): string =>
    part.replace(/^\/+/, "").replace(/\/+$/, "");
  return bare(pattern.slice(0, first)) === "" && bare(pattern.slice(pattern.lastIndexOf("*") + 1)) === "";
}

// The loadable-entry check is exact-match only: a wildcard prefix aliases a directory.
function buildPathAliasEntry(
  pattern: string,
  targets: readonly string[],
  base: string,
  configFile: string,
  warningsOut?: string[],
): TsconfigAlias | undefined {
  if (!targets.length) return undefined;
  // First target only: Vite aliases support a single replacement.
  const target = targets[0];
  if (capturesEveryRootAbsoluteUrl(pattern)) {
    warningsOut?.push(ROOT_ABSOLUTE_ALIAS_WARNING(pattern, target, configFile));
    return undefined;
  }
  if (pattern.endsWith("/*") && target.endsWith("/*")) {
    const prefix = pattern.slice(0, -2);
    const dir = toPosix(path.resolve(base, target.slice(0, -2)));
    return {
      find: new RegExp(`^${escapeRegex(prefix)}/`),
      replacement: dir + "/",
      pattern,
      target,
    };
  }
  const patternStars = countStars(pattern);
  const targetStars = countStars(target);
  if (patternStars > 0 || targetStars > 0) {
    // TypeScript allows at most one wildcard per side; anything else no alias can express.
    if (patternStars !== 1 || targetStars !== 1) {
      warningsOut?.push(ALIAS_SHAPE_WARNING(pattern, target));
      return undefined;
    }
    return { ...buildWildcardCaptureAlias(pattern, target, base), pattern, target };
  }
  const resolved = toPosix(path.resolve(base, target));
  // No @types/ substring check: resolveTarget already answers undefined for a .d.ts package.
  if (resolveTarget(resolved) === undefined) {
    warningsOut?.push(TYPES_ONLY_ALIAS_WARNING(pattern, target));
    return undefined;
  }
  return { find: new RegExp(`^${escapeRegex(pattern)}$`), replacement: resolved, pattern, target };
}

interface ParsedTsconfigPaths {
  paths?: ts.MapLike<string[]>;
  baseUrl?: string;
  base: string;
  // parseJsonConfigFileContent already produces these; kept alongside .options, not dropped.
  configErrors?: string[];
}

// Produced by model.ts's tsconfig reader; re-exported so importers of this module keep the name.
export { TSCONFIG_EXTENDS_BROKEN_WARNING };

// Vite merges user aliases ahead of its own client alias, so such a key would 404 /@vite/client.
export function ROOT_ABSOLUTE_ALIAS_WARNING(
  pattern: string,
  target: string,
  configFile: string,
): string {
  return (
    `${configFile}: the path alias "${pattern}" -> "${target}" has no prefix of its own, so it ` +
    "would rewrite every root-absolute URL the dev server serves, including Vite's own client " +
    "and the harness entry. It is skipped; the other keys in this config still apply."
  );
}

// Independent of which layer asks; undefined on a read failure, after warning to stderr.
function parseTsconfigPathsConfig(tsconfigPath: string): ParsedTsconfigPaths | undefined {
  const configDir = path.dirname(tsconfigPath);
  try {
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (configFile.error) {
      process.stderr.write(
        `Warning: could not parse tsconfig at ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, " ")}\n`,
      );
      return undefined;
    }
    // The full result is kept, not just .options, so a broken extends diagnostic survives.
    const parsedResult = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      configDir,
      undefined,
      tsconfigPath,
    );
    const options = parsedResult.options;
    // pathsBasePath is internal but stable: the directory of the config that declared paths.
    const base =
      options.baseUrl ?? (options as { pathsBasePath?: string }).pathsBasePath ?? configDir;
    // 5083 and 6053 only: 18003 "No inputs were found" is a normal config, not a broken chain.
    const EXTENDS_BROKEN_CODES = new Set([5083, 6053]);
    const configErrors = parsedResult.errors
      .filter((d) => EXTENDS_BROKEN_CODES.has(d.code))
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
    return {
      paths: options.paths,
      baseUrl: options.baseUrl,
      base,
      ...(configErrors.length > 0 ? { configErrors } : {}),
    };
  } catch (err) {
    process.stderr.write(
      `Warning: could not parse tsconfig at ${tsconfigPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return undefined;
  }
}

// loadTsconfigAliases runs several times per run and the sentence is the same every time.
const disclosedGoverningConfigs = new Set<string>();

// The register spans a process, so a test worker must start from empty.
export function resetGoverningDisclosures(): void {
  disclosedGoverningConfigs.clear();
}

export function loadTsconfigAliases(
  projectRoot: string,
  warningsOut?: string[],
  forFile?: string,
): TsconfigAlias[] {
  // Bounded by the install root: a member inheriting the workspace tsconfig needs its aliases.
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  const governing = resolveGoverningTsconfig(forFile ?? projectRoot, workspaceRoot);
  const tsconfigPath = governing.configPath;

  let memberAliases: TsconfigAlias[] = [];
  let memberPatterns = new Set<string>();
  // An empty memberPatterns set cannot tell "no config" from "baseUrl and deliberately none".
  let memberDeclaredBaseUrlOnly = false;

  // Gives up entirely rather than guess whether a root layer still applies.
  if (governing.nearestConfigPath && !tsconfigPath) {
    process.stderr.write(`Warning: ${governing.warnings[0]}\n`);
    return [];
  }

  if (tsconfigPath) {
    // A broken extends chain does not stop the rest: whatever paths parsed still apply.
    for (const warning of governing.warnings) {
      if (!warningsOut) break;
      if (warning.includes(TSCONFIG_REFERENCES_MARKER)) {
        if (disclosedGoverningConfigs.has(warning)) continue;
        disclosedGoverningConfigs.add(warning);
      }
      warningsOut.push(warning);
    }
    if (governing.options.paths) {
      // The member owns any name it lists, whether or not its own target resolves.
      memberPatterns = new Set(Object.keys(governing.options.paths));
      for (const [pattern, targets] of Object.entries(governing.options.paths)) {
        const entry = buildPathAliasEntry(
          pattern,
          targets,
          governing.base,
          tsconfigPath,
          warningsOut,
        );
        if (entry) memberAliases.push(entry);
      }
    } else if (governing.options.baseUrl) {
      memberAliases = baseUrlAliases(governing.options.baseUrl, projectRoot, workspaceRoot);
      memberDeclaredBaseUrlOnly = true;
    }
  }

  // A single-directory probe: findCompilerConfig(root, root) stops after one iteration.
  const rootConfigPath = findCompilerConfig(workspaceRoot, workspaceRoot);
  const workspaceRootAliases: TsconfigAlias[] = [];
  if (
    !memberDeclaredBaseUrlOnly &&
    rootConfigPath &&
    rootConfigPath !== tsconfigPath &&
    rootConfigPath !== governing.nearestConfigPath
  ) {
    const rootParsed = parseTsconfigPathsConfig(rootConfigPath);
    for (const detail of rootParsed?.configErrors ?? []) {
      warningsOut?.push(TSCONFIG_EXTENDS_BROKEN_WARNING(rootConfigPath, detail));
    }
    if (rootParsed?.paths) {
      for (const [pattern, targets] of Object.entries(rootParsed.paths)) {
        if (memberPatterns.has(pattern) || !targets.length) continue;
        const entry = buildPathAliasEntry(
          pattern,
          targets,
          rootParsed.base,
          rootConfigPath,
          warningsOut,
        );
        if (!entry) continue;
        workspaceRootAliases.push({
          ...entry,
          fromWorkspaceRoot: { pattern, target: targets[0], configFile: rootConfigPath },
        });
      }
    }
  }

  return [...memberAliases, ...workspaceRootAliases];
}


// One table per governing tsconfig, so a walk that crosses packages pays for each config once.
const aliasTablesByConfig = new Map<string, TsconfigAlias[]>();
// Keyed by config path: whether that config delegates its options to a `references` entry.
const referencesOnlyConfigs = new Map<string, boolean>();

export function resetTsconfigAliasTables(): void {
  aliasTablesByConfig.clear();
  referencesOnlyConfigs.clear();
}

// Raw JSON only: no glob expansion, and the same rule resolveGoverningTsconfig applies.
export function delegatesToReferences(configPath: string): boolean {
  const cached = referencesOnlyConfigs.get(configPath);
  if (cached !== undefined) return cached;
  let answer = false;
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const raw = configFile.config as { compilerOptions?: unknown; references?: unknown } | undefined;
  if (!configFile.error && raw) {
    const declared = raw.compilerOptions;
    const declaresOwnOptions =
      declared !== null &&
      typeof declared === "object" &&
      Object.keys(declared as Record<string, unknown>).length > 0;
    answer = !declaresOwnOptions && Array.isArray(raw.references) && raw.references.length > 0;
  }
  referencesOnlyConfigs.set(configPath, answer);
  return answer;
}

// The table that governs one file. Files under a references-only root are keyed one by one,
// because which referenced config covers them is a property of the file, not of the directory.
export function tsconfigAliasesForFile(projectRoot: string, file: string): TsconfigAlias[] {
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  const nearest = findCompilerConfig(path.dirname(path.resolve(file)), workspaceRoot);
  const scope =
    nearest === undefined
      ? ""
      : delegatesToReferences(nearest)
        ? pathKey(file)
        : pathKey(nearest);
  const key = `${pathKey(projectRoot)} ${scope}`;
  const cached = aliasTablesByConfig.get(key);
  if (cached) return cached;
  const aliases = loadTsconfigAliases(projectRoot, undefined, file);
  aliasTablesByConfig.set(key, aliases);
  return aliases;
}
