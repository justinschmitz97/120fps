import fs from "node:fs";
import path from "node:path";
import { escapeRegex, pathKey, toPosix } from "../shared/index.js";
import {
  findWorkspaceRoot,
  installedPackageDir,
  readProjectManifest,
  resolveDirectoryEntry,
  resolveLocalImport,
  resolveSubpathImport,
  resolveTarget,
  SOURCE_EXTENSIONS,
  subpathImportPackage,
  unbuiltSiblingSourceEntry,
  WORKSPACE_ROOT_ALIAS_WARNING,
  type WorkspaceRootAliasSource,
} from "../project/index.js";
import { packageScriptCommand } from "./bundler-failure.js";
import { relativeToRoot } from "./css.js";
import {
  declaredRuntimeEntries,
  declaresRuntimeEntry,
  isWorkspaceSibling,
  resolveWorkspaceSourceEntry,
  workspaceSubpathSourceEntries,
} from "./workspace-entries.js";

// String literals only, whole-clause `import type` excluded; the clause may span newlines.
const STATIC_IMPORT_PATTERN =
  // The clause class excludes ; " ( and /, so a side-effect import above stays its own match.
  /(?:^|\s)(?:import|export)\s+(?!type\s)[\w$*,{}\s]*?from\s+["']([^"']+)["']|(?:^|\s)import\s+["']([^"']+)["']/gm;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*["']([^"']+)["']/g;
const REQUIRE_PATTERN = /\brequire\s*\(\s*["']([^"']+)["']/g;

function readSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of [STATIC_IMPORT_PATTERN, DYNAMIC_IMPORT_PATTERN, REQUIRE_PATTERN]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const spec = match[1] ?? match[2];
      if (spec) specifiers.push(spec);
    }
  }
  return specifiers;
}

// Disclosed here so --explain-props and the real run agree instead of dying at optimization.
export function UNRESOLVED_PREBUNDLE_ENTRY_WARNING(specifier: string, importer: string): string {
  return (
    `"${specifier}" (imported by ${importer}) resolves to no installed package, no alias and no ` +
    "`imports` entry, so the pre-bundle cannot include it: the browser resolves it at request time " +
    "or fails on it."
  );
}

// One line per alias: 149 imports under one stale pattern are one fact, not 149.
export function BROKEN_ALIAS_WARNING(
  pattern: string,
  targetRoot: string,
  examples: string[],
  total: number,
): string {
  const rest = total - examples.length;
  const sample = rest > 0 ? `${examples.join(", ")} and ${rest} more` : examples.join(", ");
  const subject =
    total === 1 ? "1 import whose target does not exist" : `${total} imports whose targets do not exist`;
  return (
    `the path alias "${pattern}" -> "${targetRoot}" matched ${subject} (${sample}); the alias is ` +
    "stale or those files were moved, and the imports will not resolve in the harness"
  );
}

// Proven, not guessed: the installed package has no main/module/exports and no index file.
// The dev server has one alias list, so two packages claiming one name cannot both be served.
export function GOVERNING_ALIAS_CONFLICT_WARNING(
  specifier: string,
  importer: string,
  siblingTarget: string,
  measuredTarget: string,
): string {
  return (
    `${importer} imports "${specifier}" through its own package's path alias, which names ` +
    `${siblingTarget}; the measured package's alias of the same name points at ${measuredTarget}. ` +
    "The dev server resolves aliases from one list, so it serves the measured package's target and " +
    "this import loads the wrong file."
  );
}

export function TYPE_ONLY_PACKAGE_WARNING(pkg: string): string {
  return (
    `import "${pkg}" resolved to an installed package with no runtime entry ` +
    "(no package.json main/module/exports, no index file); the import is almost certainly " +
    "type-only and was excluded from the pre-bundle instead of aborting the harness"
  );
}

// The message names the field, its declared path and whether that path is on disk.
export function UNBUILT_WORKSPACE_SOURCE_ALIAS_WARNING(
  pkg: string,
  sourceEntry: string,
  entry?: { field: string; declared: string; exists: boolean },
): string {
  if (entry === undefined) {
    return (
      `${pkg} is a workspace package with no built entry to load; its own source at ${sourceEntry} ` +
      "resolves and was aliased in its place, so this run measures the real module."
    );
  }
  const existence = entry.exists ? "exists on disk" : "does not exist on disk";
  return (
    `${pkg} is a workspace package whose ${entry.field} names ${entry.declared}, which ${existence}; ` +
    `its own source at ${sourceEntry} resolves and was aliased in its place, so this run measures ` +
    "the real module."
  );
}

// Declarations only: nothing can fail when the browser loads it, and no build command helps.
export function TYPES_ONLY_WORKSPACE_PACKAGE_WARNING(
  pkg: string,
  typesPath: string | undefined,
): string {
  return (
    `${pkg} is a workspace package that declares no runtime entry (no main, module or exports)` +
    (typesPath ? `, only types at ${typesPath}` : "") +
    "; it ships declarations only, so it was left out of the pre-bundle and needs no build."
  );
}

// TYPE_ONLY_PACKAGE_WARNING's "excluded instead of aborting" promise is not true here.
export function UNBUILT_WORKSPACE_PACKAGE_NO_SOURCE_WARNING(
  pkg: string,
  buildCommand: string | undefined,
  entry?: { field: string; declared: string; exists: boolean },
): string {
  const build = buildCommand ? ` Run \`${buildCommand}\` in that package first.` : "";
  if (entry === undefined) {
    return (
      `${pkg} is a workspace package whose package.json points at an unbuilt dist/, and no ` +
      "resolvable source was found to measure instead: this import may still fail when the browser " +
      "loads it, not only at pre-bundle time." +
      build
    );
  }
  const existence = entry.exists ? "exists on disk" : "does not exist on disk";
  return (
    `${pkg} is a workspace package whose ${entry.field} names ${entry.declared}, which ${existence}, ` +
    "and no resolvable source was found to measure instead: this import may still fail when the " +
    "browser loads it, not only at pre-bundle time." +
    build
  );
}

// Nothing aliased the subpath itself, so its removal is disclosed instead of silent.
export function UNALIASED_WORKSPACE_SUBPATH_WARNING(specifier: string, pkg: string): string {
  return (
    `${specifier} is a subpath of the workspace package ${pkg}, whose root was aliased to its own ` +
    "source; that subpath resolved to no source of its own and was left out of the pre-bundle, so " +
    "this import may still fail when the browser loads it, not only at pre-bundle time."
  );
}

// The substitution every React Native Web bundler makes, named so the report is not a surprise.
export function REACT_NATIVE_WEB_ALIAS_WARNING(target: string): string {
  return (
    `react-native is aliased to ${target} for this run, the substitution a React Native app's own ` +
    "web target makes; a component that reaches a module react-native-web does not implement still " +
    "fails on that module."
  );
}

// A module built for React Native needs the platform extension order this harness does not set,
// so substituting react-native alone does not make it loadable.
export function REACT_NATIVE_MODULES_ERROR(importer: string, modules: string[]): string {
  const shown = modules.slice(0, 5).join(", ");
  const rest = modules.length - 5;
  const sample = rest > 0 ? `${shown} and ${rest} more` : shown;
  return (
    `${importer} reaches ${modules.length} React Native modules (${sample}). react-native itself ` +
    "is substituted by react-native-web for this run, but each of these declares react-native as " +
    "its own dependency and ships a native implementation this run cannot swap for a web one, so " +
    "it cannot load in a browser. Measure a component whose imports reach none of them."
  );
}

export function REACT_NATIVE_WITHOUT_WEB_ERROR(importer: string): string {
  return (
    `${importer} imports react-native, which renders through a native runtime this tool cannot ` +
    "host: every measurement runs against a DOM in Chromium. Install react-native-web, the web " +
    "target a React Native app builds with, or measure a component that reaches no react-native " +
    "module."
  );
}

// The manifest's own claim, not a guess from the name: a module built for React Native says so.
function dependsOnReactNative(manifest: Record<string, unknown> | undefined): boolean {
  if (!manifest) return false;
  return ["dependencies", "peerDependencies"].some((field) => {
    const declared = manifest[field];
    return (
      typeof declared === "object" &&
      declared !== null &&
      Object.prototype.hasOwnProperty.call(declared, "react-native")
    );
  });
}

type ExternalDepsAliases = Array<{
  find: RegExp;
  replacement: string;
  isShim?: boolean;
  pattern?: string;
  target?: string;
  fromWorkspaceRoot?: WorkspaceRootAliasSource;
}>;

// The table that governs one file. Absent, every file is judged by the measured package's table.
export type AliasesForFile = (file: string) => ExternalDepsAliases;

interface ExternalDepsWalkRecord {
  packages: string[];
  specifiers: string[];
  warnings: string[];
  extraAliases: Array<{ find: RegExp; replacement: string }>;
  unresolved: Array<{ specifier: string; importer: string }>;
  // Replayed so a second walk sharing the dedupe set reports what the first left it reporting.
  reported: string[];
  files: Array<[string, string | undefined]>;
}

// The key carries every input the walk reads; an entry is served only while mtimes match.
const externalDepsWalks = new Map<string, ExternalDepsWalkRecord>();

function sourceSignature(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
}

function serializeAliases(aliases: ExternalDepsAliases): unknown[] {
  return aliases.map((alias) => [
    alias.find.source,
    alias.find.flags,
    alias.replacement,
    alias.isShim ?? false,
    alias.pattern ?? null,
    alias.fromWorkspaceRoot ?? null,
  ]);
}

function externalDepsKey(
  componentPath: string,
  projectRoot: string,
  workspaceRoot: string,
  aliases: ExternalDepsAliases,
  reported: Set<string> | undefined,
  aliasesForFile: AliasesForFile | undefined,
): string {
  const resolvedComponent = path.resolve(componentPath);
  return JSON.stringify([
    resolvedComponent,
    path.resolve(projectRoot),
    path.resolve(workspaceRoot),
    serializeAliases(aliases),
    // A per-file walk is a different walk; the tables it reads follow from the two roots above.
    aliasesForFile === undefined ? null : serializeAliases(aliasesForFile(resolvedComponent)),
    [...(reported ?? [])].sort(),
  ]);
}

export function scanExternalDeps(
  componentPath: string,
  projectRoot: string,
  aliases: ExternalDepsAliases,
  specifiersOut?: Set<string>,
  warningsOut?: string[],
  workspaceRoot: string = findWorkspaceRoot(projectRoot),
  extraAliasesOut?: Array<{ find: RegExp; replacement: string }>,
  unresolvedOut?: Array<{ specifier: string; importer: string }>,
  reportedUnresolvedOut?: Set<string>,
  aliasesForFile?: AliasesForFile,
): string[] {
  const key = externalDepsKey(
    componentPath,
    projectRoot,
    workspaceRoot,
    aliases,
    reportedUnresolvedOut,
    aliasesForFile,
  );
  const cached = externalDepsWalks.get(key);
  if (cached && cached.files.every(([file, signature]) => sourceSignature(file) === signature)) {
    for (const specifier of cached.specifiers) specifiersOut?.add(specifier);
    for (const warning of cached.warnings) warningsOut?.push(warning);
    for (const alias of cached.extraAliases) extraAliasesOut?.push(alias);
    for (const entry of cached.unresolved) unresolvedOut?.push({ ...entry });
    for (const specifier of cached.reported) reportedUnresolvedOut?.add(specifier);
    return [...cached.packages];
  }

  // Collected separately: a delta against the caller's set would depend on what the key omits.
  const collected = new Set<string>();
  // The caller's own channels: a rescue alias pushed mid-walk resolves the imports below it.
  const warnings = warningsOut ?? [];
  const extraAliases = extraAliasesOut ?? [];
  const unresolved = unresolvedOut ?? [];
  const reported = reportedUnresolvedOut ?? new Set<string>();
  const reportedBefore = new Set(reported);
  const warningsBefore = warnings.length;
  const extraAliasesBefore = extraAliases.length;
  const unresolvedBefore = unresolved.length;
  const files = new Map<string, string | undefined>();

  const packages = walkExternalDeps(
    componentPath,
    projectRoot,
    aliases,
    collected,
    warnings,
    workspaceRoot,
    extraAliases,
    unresolved,
    reported,
    files,
    aliasesForFile,
  );

  for (const specifier of collected) specifiersOut?.add(specifier);

  externalDepsWalks.set(key, {
    packages: [...packages],
    specifiers: [...collected],
    warnings: warnings.slice(warningsBefore),
    extraAliases: extraAliases.slice(extraAliasesBefore),
    unresolved: unresolved.slice(unresolvedBefore).map((entry) => ({ ...entry })),
    reported: [...reported].filter((specifier) => !reportedBefore.has(specifier)),
    files: [...files],
  });
  return packages;
}

function walkExternalDeps(
  componentPath: string,
  projectRoot: string,
  aliases: ExternalDepsAliases,
  specifiersOut?: Set<string>,
  warningsOut?: string[],
  workspaceRoot: string = findWorkspaceRoot(projectRoot),
  // buildAndServe passes the array it assembles `alias` from, so a rescue applies per request.
  extraAliasesOut?: Array<{ find: RegExp; replacement: string }>,
  // In the order the walk read them, for the caller that publishes them on StaticPreBuild.
  unresolvedOut?: Array<{ specifier: string; importer: string }>,
  // Shared by the component and wrapper walks, so a specifier unresolved in both reports once.
  reportedUnresolvedOut?: Set<string>,
  // With the mtime and size it had, for the memo that decides whether the result still stands.
  filesReadOut?: Map<string, string | undefined>,
  // An import is judged by the tsconfig governing the file it was written in, not the measured one.
  aliasesForFile?: AliasesForFile,
): string[] {
  const externalPkgs = new Set<string>();
  const visited = new Set<string>();
  const reportedBrokenAliases = new Set<string>();
  // Grouped by the alias that matched, so one stale pattern is one line however many it caught.
  const brokenAliasGroups = new Map<string, { targetRoot: string; specifiers: string[] }>();
  // Specifiers a stale project alias claimed while the sibling's own source answers for them.
  const rescuedFromStaleAlias = new Set<string>();
  // Specifiers another package's tsconfig resolved; the measured table alone would not serve them.
  const reconciledAliases = new Set<string>();

  // The dev server reads one alias list, so a governing answer it cannot reproduce is disclosed.
  const serveGoverningAlias = (spec: string, resolvedPath: string, importer: string): void => {
    if (reconciledAliases.has(spec)) return;
    // Namespaced in the run-wide register: one disclosure per specifier, not one per candidate.
    const disclosureKey = `alias-conflict ${spec}`;
    const measured = resolveLocalImport(importer, spec, projectRoot, aliases);
    if (measured.kind === "resolved" && pathKey(measured.path) === pathKey(resolvedPath)) return;
    reconciledAliases.add(spec);
    if (measured.kind === "resolved") {
      if (reportedUnresolved.has(disclosureKey)) return;
      reportedUnresolved.add(disclosureKey);
      warningsOut?.push(
        GOVERNING_ALIAS_CONFLICT_WARNING(
          spec,
          relativeToRoot(importer, projectRoot),
          toPosix(resolvedPath),
          toPosix(measured.path),
        ),
      );
      return;
    }
    // Ahead of the measured package's own alias, which resolves this name nowhere.
    extraAliasesOut?.unshift({
      find: new RegExp(`^${escapeRegex(spec)}$`),
      replacement: toPosix(resolvedPath),
    });
  };
  const reportedWorkspaceRootAliases = new Set<string>();
  // One report per specifier, however many files import it.
  const reportedUnresolved = reportedUnresolvedOut ?? new Set<string>();
  const queue = [componentPath];
  const pkgNameOf = (spec: string) =>
    spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
  // A pnpm install links dependencies the entry project's own node_modules chain lacks.
  const firstImporterDir = new Map<string, string>();
  // The same at file granularity, so a specifier that resolves nowhere can name its importer.
  const firstImporterFile = new Map<string, string>();
  // Re-reads its importer from the newest file that imported it.
  const unresolvedImporters = new Set<string>();

  // Runs again from every aliased sibling source, so a rescue happens in the same pass.
  const walk = () => {
  while (queue.length > 0) {
    const file = queue.shift()!;
    const normalizedFile = path.resolve(file);
    if (visited.has(normalizedFile)) continue;
    visited.add(normalizedFile);

    // A file the walk could not read is recorded too, so one that appears later invalidates.
    filesReadOut?.set(normalizedFile, sourceSignature(normalizedFile));

    let content: string;
    try {
      content = fs.readFileSync(normalizedFile, "utf-8");
    } catch {
      continue;
    }

    for (const raw of readSpecifiers(content)) {
      // `./icon.svg?url` never resolved with the query; a "#" survives, it opens a subpath import.
      const spec = raw.split("?")[0];
      if (!spec) continue;

      const isBareSpecifier = !spec.startsWith(".") && !spec.startsWith("/");
      const localResolved = resolveLocalImport(
        normalizedFile,
        spec,
        projectRoot,
        aliasesForFile === undefined ? aliases : aliasesForFile(normalizedFile),
      );
      if (localResolved.kind === "resolved") {
        if (SOURCE_EXTENSIONS.includes(path.extname(localResolved.path))) {
          queue.push(localResolved.path);
        }
        // Only a governing table can answer differently from the one the harness hands Vite.
        if (
          isBareSpecifier &&
          aliasesForFile !== undefined &&
          localResolved.aliasPattern !== undefined &&
          !localResolved.viaShimAlias
        ) {
          serveGoverningAlias(spec, localResolved.path, normalizedFile);
        }
        // The specifier was still imported and must be reported; only the bookkeeping changes.
        if (isBareSpecifier && localResolved.viaShimAlias) specifiersOut?.add(spec);
        // Usage-triggered and deduped per specifier, so an unused root pattern buries nothing.
        if (
          isBareSpecifier &&
          localResolved.viaWorkspaceRootAlias &&
          !reportedWorkspaceRootAliases.has(spec)
        ) {
          reportedWorkspaceRootAliases.add(spec);
          const tag = localResolved.viaWorkspaceRootAlias;
          warningsOut?.push(WORKSPACE_ROOT_ALIAS_WARNING(spec, tag.pattern, tag.target, tag.configFile));
        }
      } else if (localResolved.kind === "alias-miss") {
        // A project alias that matches first must not hide the sibling source behind it.
        const siblingEntry = localResolved.viaShimAlias
          ? undefined
          : unbuiltSiblingSourceEntry(spec, normalizedFile, projectRoot, workspaceRoot);
        if (siblingEntry !== undefined) {
          if (!rescuedFromStaleAlias.has(spec)) {
            rescuedFromStaleAlias.add(spec);
            // Ahead of the alias that matched: Vite stops at its own first match too.
            extraAliasesOut?.unshift({
              find: new RegExp(`^${escapeRegex(spec)}$`),
              replacement: siblingEntry,
            });
          }
          if (SOURCE_EXTENSIONS.includes(path.extname(siblingEntry))) queue.push(siblingEntry);
          continue;
        }
        // A shim alias whose file is not built is this tool's own state; a project alias is theirs.
        if (localResolved.viaShimAlias) {
          specifiersOut?.add(spec);
        } else if (!reportedBrokenAliases.has(spec)) {
          reportedBrokenAliases.add(spec);
          const group = brokenAliasGroups.get(localResolved.aliasPattern) ?? {
            targetRoot: localResolved.aliasTargetRoot,
            specifiers: [],
          };
          group.specifiers.push(spec);
          brokenAliasGroups.set(localResolved.aliasPattern, group);
        }
      } else if (spec.startsWith("#")) {
        // Never a package to pre-bundle, and never a truncation of one ("#app/x" is not "#app").
        const viaImports = resolveSubpathImport(normalizedFile, spec);
        if (viaImports && SOURCE_EXTENSIONS.includes(path.extname(viaImports))) {
          queue.push(viaImports);
        } else if (!viaImports) {
          // The map may name a dependency; that target, never the "#" specifier, is pre-bundled.
          const viaPackage = subpathImportPackage(normalizedFile, spec);
          if (viaPackage) {
            specifiersOut?.add(viaPackage);
            externalPkgs.add(pkgNameOf(viaPackage));
          } else if (!reportedUnresolved.has(spec)) {
            // Nothing can pre-bundle it, so the specifier stays out of the include list.
            reportedUnresolved.add(spec);
            const importer = relativeToRoot(normalizedFile, projectRoot);
            unresolvedOut?.push({ specifier: spec, importer });
            warningsOut?.push(UNRESOLVED_PREBUNDLE_ENTRY_WARNING(spec, importer));
          }
        }
      } else if (isBareSpecifier) {
        specifiersOut?.add(spec);
        const pkg = spec.startsWith("@")
          ? spec.split("/").slice(0, 2).join("/")
          : spec.split("/")[0];
        const importerDir = path.dirname(normalizedFile);
        if (!firstImporterDir.has(spec) || unresolvedImporters.has(spec)) {
          firstImporterDir.set(spec, importerDir);
          firstImporterFile.set(spec, normalizedFile);
          unresolvedImporters.delete(spec);
        }
        if (!firstImporterDir.has(pkg) || unresolvedImporters.has(pkg)) {
          firstImporterDir.set(pkg, importerDir);
          firstImporterFile.set(pkg, normalizedFile);
          unresolvedImporters.delete(pkg);
        }
        if (spec === pkg) {
          // Already the bare root: covers every ordinary dependency, subpath-only ones included.
          externalPkgs.add(pkg);
        } else {
          // Collapsing to `pkg` manufactures an entry nothing wrote when the root has none.
          const pkgDir = installedPackageDir(pkg, path.dirname(normalizedFile));
          if (
            pkgDir &&
            isWorkspaceSibling(pkgDir, workspaceRoot) &&
            resolveDirectoryEntry(pkgDir) === undefined
          ) {
            externalPkgs.add(spec);
          } else {
            externalPkgs.add(pkg);
          }
        }
      }
    }
  }
  };

  const BLOCKED = new Set([
    "next", "webpack", "critters", "fibers",
    "react-server-dom-webpack", "react-server-dom-turbopack",
    "@vercel/turbopack-ecmascript-runtime",
    "@next/env", "@next/swc-linux-x64-gnu", "@next/swc-linux-x64-musl",
    "@next/swc-darwin-arm64", "@next/swc-darwin-x64",
    "@next/swc-win32-x64-msvc", "@next/swc-win32-arm64-msvc",
    "sass", "less", "stylus", "lightningcss", "sugarss",
  ]);

  // An entry may be a subpath string, so the checks apply to the re-derived package name.
  const dropIgnored = () => {
    externalPkgs.delete("react");
    externalPkgs.delete("react-dom");
    for (const entry of externalPkgs) {
      const pkg = pkgNameOf(entry);
      if (BLOCKED.has(pkg) || pkg.startsWith("@next/") || pkg.startsWith("@vercel/turbopack")) {
        externalPkgs.delete(entry);
      }
    }
  };

  // A sibling's missing entry proves its dist/ is unbuilt, not that the import is type-only.
  type SiblingDecision = { aliasedRoot: boolean; aliasedSpecifiers: Set<string> };
  // One decision per sibling per pass; an aliased source re-enters the walk to a fixed point.
  const siblingDecisions = new Map<string, SiblingDecision>();
  const decidedEntries = new Set<string>();
  const keptEntries = new Set<string>();

  const reportedUnaliasedSubpaths = new Set<string>();
  const applyDecision = (entry: string, pkg: string, decision: SiblingDecision): void => {
    if (decision.aliasedSpecifiers.has(entry) || entry === pkg) {
      externalPkgs.delete(entry);
      return;
    }
    if (!decision.aliasedRoot) return;
    externalPkgs.delete(entry);
    if (reportedUnaliasedSubpaths.has(entry)) return;
    reportedUnaliasedSubpaths.add(entry);
    warningsOut?.push(UNALIASED_WORKSPACE_SUBPATH_WARNING(entry, pkg));
  };

  const resolvePackages = (): boolean => {
    let queuedSource = false;
    for (const entry of [...externalPkgs]) {
      const pkg = pkgNameOf(entry);
      const decided = siblingDecisions.get(pkg);
      if (decided !== undefined) {
        applyDecision(entry, pkg, decided);
        continue;
      }
      if (decidedEntries.has(entry)) {
        externalPkgs.delete(entry);
        continue;
      }
      if (keptEntries.has(entry)) continue;
      const importerDir = firstImporterDir.get(entry) ?? firstImporterDir.get(pkg);
      const dir =
        installedPackageDir(pkg, projectRoot) ??
        (importerDir === undefined ? undefined : installedPackageDir(pkg, importerDir));
      if (dir === undefined) {
        // A later round can reach the same specifier from a directory where it is installed.
        unresolvedImporters.add(entry);
        unresolvedImporters.add(pkg);
        continue;
      }
      if (!isWorkspaceSibling(dir, workspaceRoot)) {
        // A subpath of a package that is not a workspace sibling keeps the resolution it has.
        if (entry !== pkg || resolveTarget(dir) !== undefined) {
          keptEntries.add(entry);
          continue;
        }
        // Proven lack of a runtime entry, never a package this walk merely failed to locate.
        decidedEntries.add(entry);
        externalPkgs.delete(entry);
        warningsOut?.push(TYPE_ONLY_PACKAGE_WARNING(entry));
        continue;
      }
      // Realpath, not the node_modules link: routing through the link layer buys nothing.
      let real: string;
      try {
        real = fs.realpathSync(dir);
      } catch {
        real = dir;
      }
      const manifest = readProjectManifest(real);
      // A sibling that declares a runtime entry is unbuilt when that entry does not resolve.
      const declaresEntry = declaresRuntimeEntry(manifest);
      if (
        resolveDirectoryEntry(dir) !== undefined ||
        (!declaresEntry && resolveTarget(dir) !== undefined)
      ) {
        keptEntries.add(entry);
        continue;
      }
      const decision: SiblingDecision = { aliasedRoot: false, aliasedSpecifiers: new Set() };
      siblingDecisions.set(pkg, decision);
      const source = declaresEntry ? resolveWorkspaceSourceEntry(real, manifest) : undefined;
      const subpaths = workspaceSubpathSourceEntries(real, manifest);
      if (source !== undefined) {
        decision.aliasedRoot = true;
        extraAliasesOut?.push({
          find: new RegExp(`^${escapeRegex(pkg)}$`),
          replacement: source.entry,
        });
        warningsOut?.push(
          UNBUILT_WORKSPACE_SOURCE_ALIAS_WARNING(pkg, source.entry, {
            field: source.field,
            declared: source.declared,
            exists: source.declaredExists,
          }),
        );
        if (SOURCE_EXTENSIONS.includes(path.extname(source.entry))) {
          queue.push(source.entry);
          queuedSource = true;
        }
      }
      for (const subpath of subpaths) {
        const specifier = `${pkg}/${subpath.subpath}`;
        decision.aliasedSpecifiers.add(specifier);
        extraAliasesOut?.push({
          find: new RegExp(`^${escapeRegex(specifier)}$`),
          replacement: subpath.entry,
        });
        queue.push(subpath.entry);
        queuedSource = true;
      }
      if (source === undefined) {
        if (!declaresEntry) {
          const types = typeof manifest?.types === "string" ? manifest.types : undefined;
          warningsOut?.push(TYPES_ONLY_WORKSPACE_PACKAGE_WARNING(pkg, types));
        } else {
          // The package manager invocation with the directory to run it in, not the body.
          const buildCommand = packageScriptCommand(real, "build", process.cwd());
          const declaredEntry = manifest ? declaredRuntimeEntries(manifest)[0] : undefined;
          warningsOut?.push(
            UNBUILT_WORKSPACE_PACKAGE_NO_SOURCE_WARNING(
              pkg,
              buildCommand,
              declaredEntry && {
                field: declaredEntry.field,
                declared: declaredEntry.declared,
                exists: fs.existsSync(path.resolve(real, declaredEntry.declared)),
              },
            ),
          );
        }
      }
      for (const known of [...externalPkgs]) {
        if (pkgNameOf(known) === pkg) applyDecision(known, pkg, decision);
      }
    }
    return queuedSource;
  };

  for (;;) {
    walk();
    dropIgnored();
    if (!resolvePackages()) break;
  }

  // After the fixed point: a rescued sibling source may still add specifiers under one alias.
  for (const [pattern, group] of brokenAliasGroups) {
    warningsOut?.push(
      BROKEN_ALIAS_WARNING(pattern, group.targetRoot, group.specifiers.slice(0, 3), group.specifiers.length),
    );
  }

  // react-native's own manifest answers a native runtime, so the browser never resolves it here.
  const reactNativeEntries = [...externalPkgs].filter((entry) => pkgNameOf(entry) === "react-native");
  if (reactNativeEntries.length > 0) {
    const importerFile = firstImporterFile.get("react-native");
    const importer =
      importerFile === undefined
        ? relativeToRoot(componentPath, projectRoot)
        : relativeToRoot(importerFile, projectRoot);
    const webDir =
      installedPackageDir("react-native-web", projectRoot) ??
      installedPackageDir("react-native-web", firstImporterDir.get("react-native") ?? projectRoot);
    if (webDir === undefined) throw new Error(REACT_NATIVE_WITHOUT_WEB_ERROR(importer));
    const nativeModules = [...externalPkgs]
      .map(pkgNameOf)
      .filter((pkg) => pkg !== "react-native" && pkg !== "react-native-web")
      .filter((pkg) => {
        const dir =
          installedPackageDir(pkg, projectRoot) ??
          installedPackageDir(pkg, firstImporterDir.get(pkg) ?? projectRoot);
        return dir !== undefined && dependsOnReactNative(readProjectManifest(dir));
      });
    if (nativeModules.length > 0) {
      throw new Error(REACT_NATIVE_MODULES_ERROR(importer, [...new Set(nativeModules)].sort()));
    }
    for (const entry of reactNativeEntries) externalPkgs.delete(entry);
    externalPkgs.add("react-native-web");
    extraAliasesOut?.push({ find: /^react-native$/, replacement: toPosix(fs.realpathSync(webDir)) });
    warningsOut?.push(REACT_NATIVE_WEB_ALIAS_WARNING(relativeToRoot(webDir, projectRoot)));
  }

  // A bare package resolving nowhere survives the fixed point and kills dep-optimization.
  for (const entry of externalPkgs) {
    if (reportedUnresolved.has(entry)) continue;
    const pkg = pkgNameOf(entry);
    const importerDir = firstImporterDir.get(entry) ?? firstImporterDir.get(pkg);
    const dir =
      installedPackageDir(pkg, projectRoot) ??
      (importerDir === undefined ? undefined : installedPackageDir(pkg, importerDir));
    if (dir !== undefined) continue;
    // The entry stays: excluding one on a resolution this scanner cannot see is worse.
    reportedUnresolved.add(entry);
    const importerFile = firstImporterFile.get(entry) ?? firstImporterFile.get(pkg);
    const importer = importerFile === undefined ? "" : relativeToRoot(importerFile, projectRoot);
    unresolvedOut?.push({ specifier: entry, importer });
    warningsOut?.push(UNRESOLVED_PREBUNDLE_ENTRY_WARNING(entry, importer));
  }

  return [...externalPkgs];
}
