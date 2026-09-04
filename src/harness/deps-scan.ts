import fs from "node:fs";
import path from "node:path";
import { escapeRegex } from "../shared/index.js";
import {
  findWorkspaceRoot,
  installedPackageDir,
  readProjectManifest,
  resolveDirectoryEntry,
  resolveLocalImport,
  resolvePackageDir,
  resolveSubpathImport,
  resolveTarget,
  SOURCE_EXTENSIONS,
  subpathImportPackage,
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

// Static imports and re-exports, dynamic import(), and require(). String
// literals only: a template literal or a computed specifier is unknowable
// without running the code.
// M77: the negative lookahead excludes a whole-clause `import type`/`export
// type` from-specifier: type-space, never loaded at runtime. A mixed clause
// (`import { type A, b } from "x"`) still matches, because `b` is a real
// value import and "x" genuinely needs runtime resolution.
// M110 (A4, gutenberg): a clause written over several lines
// (`import {`, `  escapeHTML,`, `} from "@wordpress/escape-html"`) is the same
// import. `[\w$*,{}\s]*?` spans newlines where `.` did not, and stops at the
// first character an import clause cannot contain — a `;`, a quote, a `(`, a
// comment slash — so a side-effect import standing above the clause
// (`import "./a.css"`, with or without its semicolon) stays its own match, and
// prose or JSX below an `export` keyword ends the scan instead of reaching a
// later `from "…"` and reporting its string as a specifier.
const STATIC_IMPORT_PATTERN =
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

// M110 (A1, epic-stack-F2): the scan used to `continue` past a specifier that
// resolved to nothing, so `--explain-props` and the real run both stayed silent
// until the dev server died on it at dep-optimization.
export function UNRESOLVED_PREBUNDLE_ENTRY_WARNING(specifier: string, importer: string): string {
  return (
    `"${specifier}" (imported by ${importer}) resolves to no installed package, no alias and no ` +
    "`imports` entry, so the pre-bundle cannot include it: the browser resolves it at request time " +
    "or fails on it."
  );
}

export function BROKEN_ALIAS_WARNING(specifier: string, target: string): string {
  return (
    `import "${specifier}" matches a configured path alias, but its target ${target} does not exist; ` +
    "the alias is stale or the file was moved, and the import will not resolve in the harness"
  );
}

// M77: proven, not guessed — the package resolves to an installed directory
// whose own package.json has no main/module/exports and no index file, the
// same "no loadable entry" primitive the types-only paths-alias check (1)
// uses.
export function TYPE_ONLY_PACKAGE_WARNING(pkg: string): string {
  return (
    `import "${pkg}" resolved to an installed package with no runtime entry ` +
    "(no package.json main/module/exports, no index file); the import is almost certainly " +
    "type-only and was excluded from the pre-bundle instead of aborting the harness"
  );
}

// M94 (dub-F1): a workspace sibling's own source, not its declared (unbuilt)
// dist/, now answers for the bare specifier — the alias applies to Vite's
// real per-request resolution, not only optimizeDeps, so this import
// resolves rather than merely avoiding one particular crash site.
// M107: the message names the manifest field the derivation followed, the
// path that field declared and whether that path is on disk, so no message
// claims a `dist/` the package never named.
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

// M107 (react-spectrum-F1): a workspace sibling that declares no runtime entry
// at all ships declarations only. It is not an unbuilt package, nothing about
// it can fail when the browser loads it, and no build command helps.
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

// M94 (dub-F2): the honest replacement for TYPE_ONLY_PACKAGE_WARNING when the
// package is a workspace sibling, not a genuinely external dependency: this
// import is not proven type-only, and excluding it from the pre-bundle does
// not stop Vite's own per-request resolution from hitting the identical
// unresolvable specifier the moment the browser loads the importing file —
// the "excluded... instead of aborting the harness" promise TYPE_ONLY_PACKAGE_WARNING
// makes is not true here.
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

// M107 (review): a subpath specifier of a sibling whose root was aliased is
// removed from the pre-bundle by that root decision alone. Nothing aliased the
// subpath itself, so the removal is disclosed instead of silent.
export function UNALIASED_WORKSPACE_SUBPATH_WARNING(specifier: string, pkg: string): string {
  return (
    `${specifier} is a subpath of the workspace package ${pkg}, whose root was aliased to its own ` +
    "source; that subpath resolved to no source of its own and was left out of the pre-bundle, so " +
    "this import may still fail when the browser loads it, not only at pre-bundle time."
  );
}

type ExternalDepsAliases = Array<{
  find: RegExp;
  replacement: string;
  isShim?: boolean;
  fromWorkspaceRoot?: WorkspaceRootAliasSource;
}>;

interface ExternalDepsWalkRecord {
  packages: string[];
  specifiers: string[];
  warnings: string[];
  extraAliases: Array<{ find: RegExp; replacement: string }>;
  unresolved: Array<{ specifier: string; importer: string }>;
  // Specifiers the walk added to the caller's dedupe set, replayed so a second
  // walk sharing that set reports what the first one left it reporting.
  reported: string[];
  files: Array<[string, string | undefined]>;
}

// M116 A2: the component walk and the wrapper walk run per build, and a sweep
// builds per component; the same entry over the same files, alias set and roots
// cannot produce a different list. The key carries every input the walk reads,
// including the dedupe set it was handed, and the entry is served again only
// while every file it read has the mtime and size it read.
const externalDepsWalks = new Map<string, ExternalDepsWalkRecord>();

function sourceSignature(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
}

function externalDepsKey(
  componentPath: string,
  projectRoot: string,
  workspaceRoot: string,
  aliases: ExternalDepsAliases,
  reported: Set<string> | undefined,
): string {
  return JSON.stringify([
    path.resolve(componentPath),
    path.resolve(projectRoot),
    path.resolve(workspaceRoot),
    aliases.map((alias) => [
      alias.find.source,
      alias.find.flags,
      alias.replacement,
      alias.isShim ?? false,
      alias.fromWorkspaceRoot ?? null,
    ]),
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
): string[] {
  const key = externalDepsKey(
    componentPath,
    projectRoot,
    workspaceRoot,
    aliases,
    reportedUnresolvedOut,
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

  // The walk writes into the caller's own channels, unchanged: buildAndServe
  // passes one array as both `aliases` and `extraAliasesOut`, so a rescue alias
  // pushed mid-walk resolves the imports below it. What each channel gained is
  // read off afterwards as the delta, never by substituting a collector.
  // `specifiersOut` is the one channel the walk only writes to, so it collects
  // separately: a delta against the caller's prior contents would depend on a
  // set the key does not carry, and a later walk handed an empty set would be
  // served the short list.
  const collected = new Set<string>();
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
  aliases: Array<{
    find: RegExp;
    replacement: string;
    isShim?: boolean;
    fromWorkspaceRoot?: WorkspaceRootAliasSource;
  }>,
  specifiersOut?: Set<string>,
  warningsOut?: string[],
  workspaceRoot: string = findWorkspaceRoot(projectRoot),
  // M94: a workspace-sibling package rescued by aliasing to its own source
  // (see the M77 exclusion loop below) pushes its alias here; the one caller
  // (buildAndServe) passes the same array it is already assembling `alias`
  // from, so the rescue applies to Vite's real per-request resolution too,
  // not only to optimizeDeps.
  extraAliasesOut?: Array<{ find: RegExp; replacement: string }>,
  // M110 (A2/I2): the specifiers this walk could not resolve, in the order it
  // read them, for the caller that publishes them on `StaticPreBuild`.
  unresolvedOut?: Array<{ specifier: string; importer: string }>,
  // M110 (A1, review): a caller that walks twice into one `unresolvedOut`
  // (component and wrapper) shares the dedupe set, so a specifier unresolved in
  // both walks is still reported once.
  reportedUnresolvedOut?: Set<string>,
  // M116 (A2): every file this walk read, with the mtime and size it had, for
  // the memo that decides whether the result still stands.
  filesReadOut?: Map<string, string | undefined>,
): string[] {
  const externalPkgs = new Set<string>();
  const visited = new Set<string>();
  const reportedBrokenAliases = new Set<string>();
  const reportedWorkspaceRootAliases = new Set<string>();
  // M110 (A1): one report per specifier, however many files import it.
  const reportedUnresolved = reportedUnresolvedOut ?? new Set<string>();
  const queue = [componentPath];
  const pkgNameOf = (spec: string) =>
    spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
  // M107: a sibling rescued in a later round is imported from inside another
  // package, where a pnpm install links dependencies the entry project's own
  // node_modules chain never carries. The directory the specifier was first
  // read from answers for it; projectRoot stays the first probe.
  const firstImporterDir = new Map<string, string>();
  // M110 (A1, review): the same bookkeeping at file granularity, so a specifier
  // that resolves nowhere can name the file that imported it.
  const firstImporterFile = new Map<string, string>();
  // M107 (review): a specifier whose package directory no importer has yet
  // produced re-reads its importer from the newest file that imported it.
  const unresolvedImporters = new Set<string>();

  // M107 (gutenberg-F1): the walk runs again from every source an unbuilt
  // sibling was aliased to, so a sibling first reached through an import the
  // scanner could not resolve is rescued in the same pass.
  const walk = () => {
  while (queue.length > 0) {
    const file = queue.shift()!;
    const normalizedFile = path.resolve(file);
    if (visited.has(normalizedFile)) continue;
    visited.add(normalizedFile);

    // M116 A2: what the memo above this function has to re-check before it
    // serves this walk again. A file the walk could not read is recorded too,
    // so one that appears later invalidates the entry.
    filesReadOut?.set(normalizedFile, sourceSignature(normalizedFile));

    let content: string;
    try {
      content = fs.readFileSync(normalizedFile, "utf-8");
    } catch {
      continue;
    }

    for (const raw of readSpecifiers(content)) {
      // M69: `./icon.svg?url` and `pkg/style.css?inline` never resolved with
      // the query attached. A "#" survives: it opens a Node subpath import and
      // a legitimate alias pattern.
      const spec = raw.split("?")[0];
      if (!spec) continue;

      const isBareSpecifier = !spec.startsWith(".") && !spec.startsWith("/");
      const localResolved = resolveLocalImport(normalizedFile, spec, projectRoot, aliases);
      if (localResolved.kind === "resolved") {
        if (SOURCE_EXTENSIONS.includes(path.extname(localResolved.path))) {
          queue.push(localResolved.path);
        }
        // M62: a shim alias redirects the specifier to a local file, but the
        // specifier itself was still imported and must be reported: the
        // resolution stays local (queued above), only the bookkeeping changes.
        if (isBareSpecifier && localResolved.viaShimAlias) specifiersOut?.add(spec);
        // M76: same idea for a workspace-root-sourced alias — usage-triggered
        // and deduped per specifier, so a root config with many patterns for
        // packages this component never touches does not bury the one that
        // actually mattered.
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
        // A shim alias whose file is not built yet is this tool's own state,
        // and the specifier was still imported: M62's report needs it either
        // way. A project alias pointing nowhere is the project's to fix, and
        // it is never a package.
        if (localResolved.viaShimAlias) {
          specifiersOut?.add(spec);
        } else if (!reportedBrokenAliases.has(spec)) {
          reportedBrokenAliases.add(spec);
          warningsOut?.push(BROKEN_ALIAS_WARNING(spec, localResolved.target));
        }
      } else if (spec.startsWith("#")) {
        // M108 A1: a subpath import is the importer's own package talking to
        // itself. Resolved, it is an ordinary graph edge; unresolved, it is a
        // map that lacks the key — never a package to pre-bundle, and never a
        // truncation of one ("#app/utils/misc" collapsed to "#app" is what
        // manufactured epic-stack's failure).
        const viaImports = resolveSubpathImport(normalizedFile, spec);
        if (viaImports && SOURCE_EXTENSIONS.includes(path.extname(viaImports))) {
          queue.push(viaImports);
        } else if (!viaImports) {
          // The map may name a dependency rather than a local file; that target,
          // never the "#" specifier, is what a bundler pre-bundles.
          const viaPackage = subpathImportPackage(normalizedFile, spec);
          if (viaPackage) {
            specifiersOut?.add(viaPackage);
            externalPkgs.add(pkgNameOf(viaPackage));
          } else if (!reportedUnresolved.has(spec)) {
            // M110 (A1): no file, no package, no alias. Nothing can pre-bundle
            // it, and the specifier stays out of the include list (M108) — the
            // report is the only thing that was missing.
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
          // The specifier was already the bare root: unchanged, covers every
          // ordinary dependency including subpath-only ones like swiper.
          externalPkgs.add(pkg);
        } else {
          // M76: a subpath specifier. Collapsing it to `pkg` unconditionally
          // manufactures an optimizeDeps entry nothing in the source wrote
          // when `pkg` is a workspace sibling whose own root has no
          // resolvable entry (an `exports` map with only subpath keys, no
          // `main`) — calcom-F1. Substitute the literal subpath instead, once
          // per distinct subpath; every other package keeps collapsing.
          const pkgDir = resolvePackageDir(pkg, path.dirname(normalizedFile));
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

  // M76: an entry may now be a subpath string rather than a bare name, so the
  // blocklist's membership and prefix checks apply to the package-name
  // portion re-derived from each entry, not to the raw entry text.
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

  // M77: a bare specifier that resolves to an installed package with no
  // runtime entry (no package.json main/module/exports, no index file) is
  // almost certainly type-only — the regex scanner cannot see that an import
  // is structurally type-only (`import * as CSS from 'csstype'`), so
  // correctness depends on this proof, not on syntax. A package this walk
  // cannot find at all is left alone: this only skips packages it has
  // proven lack a runtime entry, never ones it merely failed to locate.
  //
  // M94 (dub-F1/F2): that inference is wrong for a workspace sibling — its
  // "no runtime entry" only proves its *declared* dist/ is unbuilt, not that
  // the import is type-only, and excluding a genuinely value-imported bare
  // specifier from optimizeDeps does not stop Vite's own per-request
  // resolution from failing on the identical specifier the moment the
  // browser loads the file that imports it (dub's exact crash, right after
  // the "excluded from the pre-bundle" warning printed). A workspace sibling
  // with a resolvable src/ entry is aliased to it instead of excluded, so
  // both the optimizer and Vite's real resolver succeed; one with no
  // resolvable source anywhere is still excluded (nothing else is safe), but
  // the warning stops promising a crash it cannot actually prevent.
  //
  // M107: each sibling is decided once per pass; a sibling aliased to its own
  // source hands that source back to the walk, so the pass reaches a fixed
  // point instead of stopping at the first ring of imports.
  type SiblingDecision = { aliasedRoot: boolean; aliasedSpecifiers: Set<string> };
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
        (importerDir === undefined ? undefined : resolvePackageDir(pkg, importerDir));
      if (dir === undefined) {
        // M107 (review): the importer this specifier was first read from may be
        // a file where the package is not installed; a later round can reach the
        // same specifier from a directory where it is, so the entry is left
        // undecided rather than kept for good.
        unresolvedImporters.add(entry);
        unresolvedImporters.add(pkg);
        continue;
      }
      if (!isWorkspaceSibling(dir, workspaceRoot)) {
        // A subpath of a package that is not a workspace sibling keeps the
        // resolution it has today (M76, calcom-F1).
        if (entry !== pkg || resolveTarget(dir) !== undefined) {
          keptEntries.add(entry);
          continue;
        }
        decidedEntries.add(entry);
        externalPkgs.delete(entry);
        warningsOut?.push(TYPE_ONLY_PACKAGE_WARNING(entry));
        continue;
      }
      // Realpath, not the node_modules symlink/junction location: the
      // physical source directory, matching isWorkspaceSibling's own check
      // and avoiding routing Vite's resolution and fs watching through the
      // link layer for no reason.
      let real: string;
      try {
        real = fs.realpathSync(dir);
      } catch {
        real = dir;
      }
      const manifest = readProjectManifest(real);
      // M107: a sibling that declares a runtime entry is unbuilt when that
      // entry does not resolve, whatever else happens to sit in its root; one
      // that declares none keeps M94's probe.
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
          // M111 A5: the package manager invocation of the script name, with the
          // directory to run it in, never the script body.
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

  // M110 (A1, review): the `#`-specifier branch above covers only what M108
  // already keeps out of the include list. The root cause is here: a bare
  // package that resolves to no installed directory in any round survives the
  // fixed point, reaches optimizeDeps.include and kills the run at
  // dep-optimization. The entry itself stays (M77/M94: an entry excluded on a
  // resolution this scanner cannot see is worse than one Vite resolves per
  // request); the report is what was missing.
  for (const entry of externalPkgs) {
    if (reportedUnresolved.has(entry)) continue;
    const pkg = pkgNameOf(entry);
    const importerDir = firstImporterDir.get(entry) ?? firstImporterDir.get(pkg);
    const dir =
      installedPackageDir(pkg, projectRoot) ??
      (importerDir === undefined ? undefined : resolvePackageDir(pkg, importerDir));
    if (dir !== undefined) continue;
    reportedUnresolved.add(entry);
    const importerFile = firstImporterFile.get(entry) ?? firstImporterFile.get(pkg);
    const importer = importerFile === undefined ? "" : relativeToRoot(importerFile, projectRoot);
    unresolvedOut?.push({ specifier: entry, importer });
    warningsOut?.push(UNRESOLVED_PREBUNDLE_ENTRY_WARNING(entry, importer));
  }

  return [...externalPkgs];
}
