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
import { escapeRegex, toPosix } from "../shared/index.js";

// An entry whose two halves disagree about the wildcard produces a regex
// that can never match, so the alias would be absent with nothing saying
// so. Fires only on a genuine wildcard-count mismatch (mantine's and
// material-ui's own shapes -- one wildcard on each side, just not both
// trailing -- build a working alias instead; see buildWildcardCaptureAlias).
// The text is generated from the two counts, not a fixed claim: "one side
// has a * and the other does not" would be false whenever both sides have
// exactly one.
function countStars(s: string): number {
  return (s.match(/\*/g) ?? []).length;
}

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

// Both pattern and target carry exactly one `*`, just not both as the
// whole trailing segment (mantine: pattern trailing, target mid-path;
// material-ui: pattern trailing, target extension-suffixed). Splits each on
// its `*` and builds a RegExp `find` with a capture group; Vite's alias
// replacement (@rollup/plugin-alias) substitutes `$1` from that capture the
// same way it already does for the trailing-both-sides case above. The
// target's prefix/suffix are resolved against `base` by substituting a
// private placeholder token for the `*`, running path.resolve once (so `.`/
// `..` segments and separator normalization are handled exactly as the
// trailing case already handles them), then splitting the result back apart
// on that token -- correct regardless of where in the target string the `*`
// sits. No loadable-entry check runs here, matching the trailing case: a
// wildcard alias points at a directory prefix Vite resolves per request, not
// a single module load.
const WILDCARD_ALIAS_PLACEHOLDER = "__120fpsSTAR__";

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

// The CRA shape. With baseUrl set and no paths, a bare specifier resolves
// against baseUrl, so every top-level entry there is an alias. A name the
// project declares or has installed is left alone: node resolution owns it.
function baseUrlAliases(
  baseUrl: string,
  memberRoot: string,
  workspaceRoot: string,
): Array<{ find: RegExp; replacement: string }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseUrl, { withFileTypes: true });
  } catch {
    return [];
  }
  const aliases: Array<{ find: RegExp; replacement: string }> = [];
  const claimed = new Set<string>();
  // Files first: a file wins over a directory of the same name, as it does in
  // node resolution.
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
      // A directory also answers for everything under it; a file answers for
      // its own name alone.
      find: new RegExp(`^${escapeRegex(name)}${isDirectory ? "(?=/|$)" : "$"}`),
      replacement: toPosix(path.resolve(baseUrl, entry.name)),
    });
  }
  return aliases;
}

// Tags a tsconfig-`paths` alias built from the workspace root's own
// config rather than the member's: the same "attributable, not just working"
// contract WORKSPACE_ROOT_ALIAS_WARNING discloses on first use.
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

// A non-wildcard `paths` target that TypeScript resolves but that has no
// runtime entry (an @types/* stub, a .d.ts-only package) would become an
// inert-but-present alias that crashes the harness the moment something
// imports it.
export function TYPES_ONLY_ALIAS_WARNING(pattern: string, target: string): string {
  return (
    `tsconfig path alias "${pattern}" -> "${target}" resolves to a location with no runtime entry ` +
    "(no package.json main/module/exports, no index file); the alias was skipped and " +
    `"${pattern}" resolves through normal node resolution instead`
  );
}

// True when nothing outside the key's wildcard constrains what it matches, so
// the alias fires on every root-absolute URL: "*" and "/*" do, "@/*" (prefix
// "@"), "/app/*" (prefix "app") and "*-suffix" (suffix "-suffix") do not. The
// slashes are stripped because a leading one is what a root-absolute URL is
// made of, not a constraint on the rest of the path.
function capturesEveryRootAbsoluteUrl(pattern: string): boolean {
  const first = pattern.indexOf("*");
  if (first === -1) return false;
  const bare = (part: string): string =>
    part.replace(/^\/+/, "").replace(/\/+$/, "");
  return bare(pattern.slice(0, first)) === "" && bare(pattern.slice(pattern.lastIndexOf("*") + 1)) === "";
}

// The per-entry logic shared by the member's own `paths` and, additively, the
// workspace root's. The loadable-entry check applies to the exact-match
// branch only: a `@/*`-style prefix aliases a directory Vite resolves per
// request, never as a single module load, so there is nothing to check there.
function buildPathAliasEntry(
  pattern: string,
  targets: readonly string[],
  base: string,
  configFile: string,
  warningsOut?: string[],
): { find: RegExp; replacement: string } | undefined {
  if (!targets.length) return undefined;
  // First target only: Vite aliases support a single replacement.
  const target = targets[0];
  // A key with no prefix and no suffix of its own fires on every
  // root-absolute URL, which is Vite's client, /@fs/ and the harness entry too.
  if (capturesEveryRootAbsoluteUrl(pattern)) {
    warningsOut?.push(ROOT_ABSOLUTE_ALIAS_WARNING(pattern, target, configFile));
    return undefined;
  }
  if (pattern.endsWith("/*") && target.endsWith("/*")) {
    const prefix = pattern.slice(0, -2);
    const dir = toPosix(path.resolve(base, target.slice(0, -2)));
    return { find: new RegExp(`^${escapeRegex(prefix)}/`), replacement: dir + "/" };
  }
  const patternStars = countStars(pattern);
  const targetStars = countStars(target);
  if (patternStars > 0 || targetStars > 0) {
    // Exactly one wildcard on each side builds a working alias via a
    // capture-group replacement, regardless of where in the target string the
    // `*` sits (mantine: mid-path; material-ui: extension-suffixed). Anything
    // else -- a genuine count mismatch, or more than one wildcard on a side
    // (TypeScript itself restricts a `paths` pattern to at most one) -- has
    // no single alias that can express it.
    if (patternStars !== 1 || targetStars !== 1) {
      warningsOut?.push(ALIAS_SHAPE_WARNING(pattern, target));
      return undefined;
    }
    return buildWildcardCaptureAlias(pattern, target, base);
  }
  const resolved = toPosix(path.resolve(base, target));
  // TypeScript's own module graph includes @types/* stubs and .d.ts-only
  // packages that resolve fine for the type checker but have no runtime
  // entry a bundler can load. No separate @types/ substring check is needed:
  // such a package declares none of exports/module/main and ships only
  // .d.ts files, which resolveTarget already treats as unresolvable.
  if (resolveTarget(resolved) === undefined) {
    warningsOut?.push(TYPES_ONLY_ALIAS_WARNING(pattern, target));
    return undefined;
  }
  return { find: new RegExp(`^${escapeRegex(pattern)}$`), replacement: resolved };
}

interface ParsedTsconfigPaths {
  paths?: ts.MapLike<string[]>;
  baseUrl?: string;
  base: string;
  // A broken `extends` chain (nuxt-ui's `./.nuxt/tsconfig.json`, absent
  // pre-build) is a diagnostic parseJsonConfigFileContent already produces,
  // kept here alongside .options rather than discarded.
  configErrors?: string[];
}

// Produced by the one tsconfig reader in `model.ts`; re-exported here so
// every existing importer keeps this name.
export { TSCONFIG_EXTENDS_BROKEN_WARNING };

// react-spectrum's root declares
// `paths: { "/*": ["./*"] }`. Vite merges user aliases ahead of its own client
// alias, so the alias built from that key would rewrite `/@vite/client` and
// the harness entry into the workspace root: two 404s and exit 2 before
// anything renders. A key with no prefix of its own aliases every root-absolute URL the
// dev server owns, so it builds no alias at all.
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

// Reads and resolves one tsconfig/jsconfig's `paths`/`baseUrl`, independent of
// which layer (member or workspace root) is asking. Returns undefined on a
// read/parse failure, after warning to stderr.
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
    // parseJsonConfigFileContent resolves extends (string and array), JSONC,
    // and trailing commas; baseUrl comes back absolute. The full result
    // is kept (not just .options) so a broken extends target's diagnostic
    // survives instead of being discarded.
    const parsedResult = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      configDir,
      undefined,
      tsconfigPath,
    );
    const options = parsedResult.options;
    // Alias base: resolved baseUrl when set; else the directory of the config
    // that declared "paths" (pathsBasePath, internal but stable), else the
    // tsconfig's own directory.
    const base =
      options.baseUrl ?? (options as { pathsBasePath?: string }).pathsBasePath ?? configDir;
    // Scoped to the two diagnostic codes TypeScript actually uses for an
    // unresolvable extends target (5083 "Cannot find a base configuration
    // file", 6053 "File not found" — the latter covers an extends chain that
    // resolves one file but not a further one it itself extends). Every
    // other parseJsonConfigFileContent diagnostic is unrelated noise —
    // 18003 "No inputs were found" fires for the
    // overwhelming majority of this file's own test fixtures (a tmpdir tsconfig
    // with no matching source files is a completely normal, working config),
    // and surfacing it here would be a false positive on nearly every existing
    // test, not a real defect.
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

// The references handover describes the run, not the caller, so it
// is disclosed once per process per config — `loadTsconfigAliases` runs several
// times in one run and the sentence is the same every time.
const disclosedGoverningConfigs = new Set<string>();

// The register spans a process, so a test process measuring several projects
// needs to start from empty; without this every assertion on a first
// disclosure depends on which test file ran first in the same worker.
export function resetGoverningDisclosures(): void {
  disclosedGoverningConfigs.clear();
}

export function loadTsconfigAliases(
  projectRoot: string,
  warningsOut?: string[],
  forFile?: string,
): Array<{ find: RegExp; replacement: string; fromWorkspaceRoot?: WorkspaceRootAliasSource }> {
  // Upward from the member, bounded by the root that governs the install.
  // Without this, a member inheriting the workspace tsconfig would get no
  // aliases at all. Through the reader, so a references-only root hands over
  // to the referenced config that covers the file being measured.
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  const governing = resolveGoverningTsconfig(forFile ?? projectRoot, workspaceRoot);
  const tsconfigPath = governing.configPath;

  let memberAliases: Array<{ find: RegExp; replacement: string }> = [];
  let memberPatterns = new Set<string>();
  // An empty memberPatterns set means two different things — "the
  // member declared no usable config at all" (still gets the fallback) and
  // "the member declared baseUrl and deliberately no paths" (must not:
  // baseUrl-only workspace-root fallback is explicitly out of scope — no
  // finding is shaped this way, and extending it without evidence would be
  // guessing). Only the second case sets this flag.
  let memberDeclaredBaseUrlOnly = false;

  // A malformed member config gives up entirely rather than guessing
  // whether a root layer should still apply. The reader keeps
  // quiet about it so this message is printed once, by whoever asked.
  if (governing.nearestConfigPath && !tsconfigPath) {
    process.stderr.write(`Warning: ${governing.warnings[0]}\n`);
    return [];
  }

  if (tsconfigPath) {
    // A broken extends chain (parseJsonConfigFileContent's own
    // diagnostics, otherwise discarded) is disclosed once per config file —
    // the rest of this function still runs on whatever paths/baseUrl it
    // could parse despite the broken part of the chain. The references
    // handover travels the same channel, once per process per config.
    for (const warning of governing.warnings) {
      if (!warningsOut) break;
      if (warning.includes(TSCONFIG_REFERENCES_MARKER)) {
        if (disclosedGoverningConfigs.has(warning)) continue;
        disclosedGoverningConfigs.add(warning);
      }
      warningsOut.push(warning);
    }
    if (governing.options.paths) {
      // The member's own declared pattern names, regardless of whether its
      // own target resolves: the member deliberately owns any name it lists.
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

  // A second, additive layer. A single-directory probe of workspaceRoot
  // itself, not a walk (findCompilerConfig(workspaceRoot, workspaceRoot) stops
  // after one iteration either way), and only for patterns the member's own
  // config does not declare.
  const rootConfigPath = findCompilerConfig(workspaceRoot, workspaceRoot);
  const workspaceRootAliases: Array<{
    find: RegExp;
    replacement: string;
    fromWorkspaceRoot: WorkspaceRootAliasSource;
  }> = [];
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
