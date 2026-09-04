import fs from "node:fs";
import path from "node:path";
import {
  findWorkspaceRoot,
  isFile,
  loadTsconfigAliases,
  readProjectManifest,
} from "../project/index.js";
import { packageScriptCommand } from "./bundler-failure.js";
import { detectRuntimeStyleEngines, unrecognisedRuntimeStyleEngine } from "./style-tooling.js";
import {
  CSS_FALLBACK_WARNING,
  CSS_PLACEHOLDER_SKIPPED_WARNING,
  CSS_RESET_SKIPPED_WARNING,
  GLOBAL_CSS_CANDIDATES,
  entryStylesheetImports,
  isCssModule,
  isOptInResetName,
  isStylesheet,
  preprocessorFor,
  resolveStylesheetImportTarget,
  stylesheetImportSpecifiers,
  stylesheetRuleCount,
  validateCssFiles,
} from "./stylesheets.js";
import { readViteConfigData } from "./vite-config.js";

const NEXT_ENTRY_STEMS = ["app/layout", "src/app/layout", "pages/_app", "src/pages/_app"];
const ENTRY_EXTENSIONS = [".tsx", ".jsx", ".ts", ".js"];
const MODULE_SCRIPT_TAG = /<script\b[^>]*>/gi;

// The module one html file loads. `rootDir` is the directory a root-absolute
// `src="/x.js"` is resolved against — Vite's own `root`, which is the package
// root only when the config declares no other one (M114 A3).
function entryFromHtml(html: string, rootDir: string): string | undefined {
  let markup: string;
  try {
    markup = fs.readFileSync(html, "utf-8");
  } catch {
    return undefined;
  }
  MODULE_SCRIPT_TAG.lastIndex = 0;
  for (const tag of markup.match(MODULE_SCRIPT_TAG) ?? []) {
    if (!/\btype\s*=\s*["']module["']/i.test(tag)) continue;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src)) continue;
    const resolved = src.startsWith("/")
      ? path.join(rootDir, src)
      : path.resolve(path.dirname(html), src);
    if (isFile(resolved)) return resolved;
  }
  return undefined;
}

// The module the project's own toolchain starts from: what index.html loads, or
// the module Next.js renders every route through.
// M114 A3, A5 (vuetify-F1): the package root's own index.html still decides
// first; a `root` the vite config declares and a foldable
// `build.rollupOptions.input` are two more places one can be, and vuetify has
// its only entry under the first of them.
export function findProjectEntry(
  projectRoot: string,
  opts?: { configRoot?: string; rollupInputs?: string[] },
): string | undefined {
  const fromPackageRoot = entryFromHtml(path.join(projectRoot, "index.html"), projectRoot);
  if (fromPackageRoot) return fromPackageRoot;

  const configRoot = opts?.configRoot;
  if (configRoot && path.resolve(configRoot) !== path.resolve(projectRoot)) {
    const fromConfigRoot = entryFromHtml(path.join(configRoot, "index.html"), configRoot);
    if (fromConfigRoot) return fromConfigRoot;
  }
  for (const input of opts?.rollupInputs ?? []) {
    const fromInput = entryFromHtml(input, configRoot ?? projectRoot);
    if (fromInput) return fromInput;
  }

  for (const stem of NEXT_ENTRY_STEMS) {
    for (const extension of ENTRY_EXTENSIONS) {
      const candidate = path.join(projectRoot, stem + extension);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

const STYLESHEET_SCAN_SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "public",
  "storybook-static",
]);
const STYLESHEET_SCAN_MAX_DEPTH = 8;
const STYLESHEET_SCAN_MAX_ENTRIES = 4000;

// Bounded walk shared by the largest-stylesheet fallback and the ranked
// candidate list: a repository is big and this runs before anything is
// measured.
export function rankedStylesheets(projectRoot: string): Array<{ file: string; size: number }> {
  const found: Array<{ file: string; size: number }> = [];
  let visited = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > STYLESHEET_SCAN_MAX_DEPTH || visited >= STYLESHEET_SCAN_MAX_ENTRIES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= STYLESHEET_SCAN_MAX_ENTRIES) return;
      visited++;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || STYLESHEET_SCAN_SKIP_DIRS.has(entry.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isStylesheet(entry.name) || isCssModule(entry.name)) continue;
      let size: number;
      try {
        size = fs.statSync(full).size;
      } catch {
        continue;
      }
      found.push({ file: full, size });
    }
  };

  walk(projectRoot, 0);
  // Descending by size; ties break on path so one project always yields one
  // answer regardless of directory-traversal order.
  return found.sort((a, b) => b.size - a.size || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

// Last resort. Ties break on path so one project always yields one answer.
export function largestStylesheet(projectRoot: string): string | undefined {
  return rankedStylesheets(projectRoot)[0]?.file;
}

export interface CssDiscovery {
  files: string[];
  // M102: "package-declared" is a pick made from the measured package's own
  // manifest (`style`, `exports["./styles"]`, `exports[*].style`) — evidence
  // the package itself published, distinct from a conventional filename.
  source: "entry" | "package-declared" | "candidate" | "fallback" | "runtime" | "none";
  // present only when source === "fallback"
  onlyCandidate?: boolean;
  noEntryInPackage?: boolean;
  // present when source === "runtime", and on the "none" of a declared-but-
  // unbuilt stylesheet whose package also styles at runtime (M112 review).
  runtimeEngines?: string[];
  // M114 A1, A2 / I5 (fluentui-F3): whether the engines above are ones
  // RUNTIME_STYLE_ENGINES names. `false` means the measured file imported a
  // `makeStyles`/`createUseStyles`/`styled` binding from a package the list
  // does not carry — an observation about one file, not a fact about the
  // package's dependencies. Present whenever `runtimeEngines` is.
  runtimeEnginesRecognised?: boolean;
  // M112 A1, A2 / I5 (radix-themes-F2): the measured package's own declarations
  // whose target is not on disk, as projectRoot-relative posix paths beside the
  // manifest field that named them. Present only when `source` is "none"
  // because the declaration is what stopped the size-ranked fallback.
  declaredMissing?: Array<{ field: string; path: string; buildCommand?: string }>;
}

// M102 (heroui-F1): the fields a package uses to tell a bundler where its own
// stylesheet is. Read in the order a "style" condition would be looked up, and
// only for the measured package itself — never an ancestor application's
// manifest (M82).
// M112 A1 / I5 (radix-themes-F2): a declaration whose target is absent used to
// leave no trace, so a package that names its own stylesheet and has not built
// it read exactly like a package that names none. The two answers are kept
// apart in the `StylesheetImportTarget` shape this file already uses, and the
// declared arm carries the manifest field that named it so a remedy can quote
// it back.
export type PackageStylesheetCandidate = { file: string } | { declared: string; field: string };

export function packageStylesheetCandidates(projectRoot: string): PackageStylesheetCandidate[] {
  const manifest = readProjectManifest(projectRoot);
  if (!manifest) return [];
  const declared: Array<{ field: string; value: string }> = [];
  const add = (field: string, value: unknown): void => {
    if (typeof value === "string" && isStylesheet(value)) declared.push({ field, value });
  };
  add("style", manifest.style);
  const exportsField = manifest.exports;
  if (exportsField && typeof exportsField === "object" && !Array.isArray(exportsField)) {
    const entries = exportsField as Record<string, unknown>;
    const styleOf = (entry: unknown): unknown =>
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>).style ?? (entry as Record<string, unknown>).default
          : undefined;
    add("exports[./styles]", styleOf(entries["./styles"]));
    add("exports[./style.css]", styleOf(entries["./style.css"]));
    for (const [subpath, entry] of Object.entries(entries)) {
      if (subpath === "./styles" || subpath === "./style.css") continue;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      add(`exports[${subpath}].style`, (entry as Record<string, unknown>).style);
    }
  }
  const targets: PackageStylesheetCandidate[] = [];
  const seen = new Set<string>();
  for (const { field, value } of declared) {
    const resolved = path.resolve(projectRoot, value);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    targets.push(isFile(resolved) ? { file: resolved } : { declared: resolved, field });
  }
  return targets;
}

// M112 A1 (radix-themes-F2): the package said where its stylesheet is; the
// build that writes it has not run. Named by the field that declared it, the
// path it points at and the package's own build script, on the M95 rule that a
// remedy quotes a script the manifest declares or none at all.
export function CSS_DECLARED_UNBUILT_WARNING(
  declarations: Array<{ field: string; path: string }>,
  buildCommand?: string,
  // M112 review: a package that declares an unbuilt stylesheet and also styles
  // at runtime is not measured unstyled — M82's outcome stands, so the clause
  // asserting it names the engines that do the styling instead.
  runtimeEngines: string[] = [],
): string {
  const named = declarations
    .map((d) => `"${d.field}" declares ${d.path}`)
    .join(declarations.length === 2 ? " and " : ", ");
  const one = declarations.length === 1;
  return (
    `this package's package.json ${named}, which ${one ? "is" : "are"} not on disk yet — ` +
    `most likely because a build this harness never runs produces ${one ? "it" : "them"}. ` +
    (runtimeEngines.length > 0
      ? `No stylesheet was injected; styling is generated at runtime by ${runtimeEngines.join(", ")}, ` +
        "so a built stylesheet may add nothing. "
      : "No stylesheet was injected and the component is measured unstyled; ") +
    (buildCommand ? `run \`${buildCommand}\` in this package` : "build this package") +
    ", then re-run, or pass --css to name a stylesheet that exists."
  );
}

export function CSS_PASSTHROUGH_RESOLVED_WARNING(candidate: string, targets: string[]): string {
  return (
    `${candidate} declares no CSS rule of its own; the stylesheet it imports, ${targets.join(", ")}, ` +
    "was injected in its place"
  );
}

export function CSS_BROKEN_IMPORT_SKIPPED_WARNING(file: string, specifier: string, target: string): string {
  return (
    `${file} imports "${specifier}", which resolves to ${target} — a file that does not exist, most ` +
    "likely because it is generated by a build this harness never runs. The stylesheet was not " +
    "injected and the component is measured unstyled; run that package's build, or pass --css to " +
    "name a stylesheet that resolves."
  );
}

// A candidate that carries rules is used as it is. A 0-rule passthrough
// (heroui's `src/styles.css`: a comment and one `@import`) stands for the
// stylesheet it imports, so that stylesheet is what gets injected.
function expandPassthroughStylesheet(
  candidate: string,
  projectRoot: string,
  aliases: Array<{ find: RegExp; replacement: string }>,
  warningsOut?: string[],
): string[] {
  if (stylesheetRuleCount(candidate) > 0) return [candidate];
  const resolved: string[] = [];
  for (const specifier of stylesheetImportSpecifiers(candidate)) {
    const target = resolveStylesheetImportTarget(specifier, candidate, projectRoot, aliases);
    if (target && "file" in target && !resolved.includes(target.file)) resolved.push(target.file);
  }
  if (resolved.length === 0) return [];
  warningsOut?.push(
    CSS_PASSTHROUGH_RESOLVED_WARNING(
      relativeToRoot(candidate, projectRoot),
      resolved.map((file) => relativeToRoot(file, projectRoot)),
    ),
  );
  return resolved;
}

export function relativeToRoot(file: string, projectRoot: string): string {
  return path.relative(projectRoot, file).replace(/\\/g, "/");
}

// M102 (shadcn-ui-F1/F2): a stylesheet that resolves and reads fine can still
// fail to compile because something it imports does not exist — the condition
// the bundler used to discover, fatally for two of four components and
// recoverably for the other two depending on which surface its rejection
// reached. Decidable here, from the filesystem, before any server starts.
function brokenNestedImport(
  file: string,
  projectRoot: string,
  aliases: Array<{ find: RegExp; replacement: string }>,
): { specifier: string; target: string } | undefined {
  for (const specifier of stylesheetImportSpecifiers(file)) {
    const target = resolveStylesheetImportTarget(specifier, file, projectRoot, aliases);
    if (target && "declared" in target) return { specifier, target: target.declared };
  }
  return undefined;
}

// M71: evidence before convention. What the project's own entry imports is what
// the project loads; a filename list is a guess, and the largest stylesheet in
// the tree is a guess that says so.
// M82: the largest-stylesheet fallback distrusts itself before it fires (an
// unbuilt placeholder or an opt-in reset by name is skipped and warned about),
// and when nothing survives that walk, runtime CSS-in-JS is checked as a
// first-class "no static stylesheet was ever going to exist" outcome before
// falling all the way to "none".
// M102 (I6, mantine-F1): `extraEntryFiles` are files the harness itself mounts
// through (the resolved `--wrap`/`120fps.setup.*` module), read for their own
// side-effect stylesheet imports exactly as the project entry is. A wrapper is
// not an application entry, so it never changes `noEntryInPackage`: what it
// changes is whether a stylesheet the run really loads is disclosed.
export function discoverGlobalCss(
  projectRoot: string,
  warningsOut?: string[],
  // M114 A2 (fluentui-F3 review): the file the run measures, read only for the
  // styling binding it imports. Absent means the unrecognised-engine branch is
  // never taken, so the line stays "none found".
  opts?: { extraEntryFiles?: string[]; measuredFile?: string },
): CssDiscovery {
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  const aliases = loadTsconfigAliases(projectRoot);
  // M102: a file rejected by one layer stays rejected for every later one —
  // shadcn's `app/globals.css` is both the entry's own import and a
  // conventional filename, and re-picking it one layer down would undo the
  // rejection the layer above just disclosed.
  const rejected = new Set<string>();
  const injectable = (file: string): boolean => {
    if (rejected.has(file)) return false;
    const broken = brokenNestedImport(file, projectRoot, aliases);
    if (!broken) return true;
    rejected.add(file);
    warningsOut?.push(
      CSS_BROKEN_IMPORT_SKIPPED_WARNING(
        relativeToRoot(file, projectRoot),
        broken.specifier,
        relativeToRoot(broken.target, projectRoot),
      ),
    );
    return false;
  };

  // M114 A3, A5 (vuetify-F1): the entry chain is what the project's own config
  // says it is. A `root` the config declares moves index.html out of the
  // package root, and a foldable `build.rollupOptions.input` names an html
  // file that is nowhere near either.
  const viteConfig = readViteConfigData(projectRoot, workspaceRoot);
  const entry = findProjectEntry(projectRoot, {
    ...(viteConfig.root !== undefined ? { configRoot: viteConfig.root } : {}),
    ...(viteConfig.rollupInputs !== undefined ? { rollupInputs: viteConfig.rollupInputs } : {}),
  });
  const entryFiles: string[] = [];
  for (const file of [...(entry ? [entry] : []), ...(opts?.extraEntryFiles ?? [])]) {
    const resolved = path.resolve(file);
    if (!entryFiles.includes(resolved)) entryFiles.push(resolved);
  }
  if (entryFiles.length > 0) {
    const imported: string[] = [];
    for (const entryFile of entryFiles) {
      const files = validateCssFiles(
        entryStylesheetImports(entryFile, projectRoot, aliases, warningsOut, workspaceRoot),
        warningsOut,
      );
      for (const file of files) if (!imported.includes(file)) imported.push(file);
    }
    const usable = imported.filter(injectable);
    if (usable.length > 0) return { files: usable, source: "entry" };
  }

  // M102 (heroui-F1): what the package says about itself, above a filename
  // convention and above the size-ranked guess.
  const packageDeclared = packageStylesheetCandidates(projectRoot);
  const declaredCandidates: Array<{ file: string; source: "package-declared" | "candidate" }> = [
    ...packageDeclared
      .filter((target): target is { file: string } => "file" in target)
      .map((target) => ({
        file: target.file,
        source: "package-declared" as const,
      })),
    ...GLOBAL_CSS_CANDIDATES.map((name) => path.join(projectRoot, name))
      .filter(isFile)
      .map((file) => ({ file, source: "candidate" as const })),
  ];
  for (const { file: candidate, source } of declaredCandidates) {
    if (preprocessorFor(candidate, projectRoot, workspaceRoot)) continue;
    if (!injectable(candidate)) continue;
    const files = expandPassthroughStylesheet(candidate, projectRoot, aliases, warningsOut).filter(
      injectable,
    );
    if (files.length === 0) {
      // A passthrough that resolves to nothing: the same skip, and the same
      // disclosure, an unbuilt placeholder has always had. Recorded as
      // rejected so the ranked walk below skips it silently instead of
      // repeating the warning this layer just made.
      if (stylesheetRuleCount(candidate) === 0) {
        rejected.add(candidate);
        warningsOut?.push(CSS_PLACEHOLDER_SKIPPED_WARNING(relativeToRoot(candidate, projectRoot)));
      }
      continue;
    }
    return { files, source };
  }

  // M112 A1, A2 (radix-themes-F2): a package that declares its own stylesheet
  // and has not built it yet is not a package without one. The size-ranked
  // walk below would inject an unrelated file and call it the global sheet,
  // so the declaration is disclosed and the walk never starts.
  const declaredMissingTargets = packageDeclared.filter(
    (target): target is { declared: string; field: string } => "declared" in target,
  );
  if (declaredMissingTargets.length > 0) {
    const buildCommand = packageScriptCommand(projectRoot, "build");
    const declaredMissing = declaredMissingTargets.map((target) => ({
      field: target.field,
      path: relativeToRoot(target.declared, projectRoot),
      ...(buildCommand !== undefined ? { buildCommand } : {}),
    }));
    // The runtime layer (M82) sits below the ranked walk this return skips, so
    // it is asked here: an unbuilt declaration plus emotion or styled-components
    // is a package whose styling never needed a static stylesheet.
    const declaredRuntimeEngines = detectRuntimeStyleEngines(projectRoot, workspaceRoot);
    warningsOut?.push(
      CSS_DECLARED_UNBUILT_WARNING(declaredMissing, buildCommand, declaredRuntimeEngines),
    );
    return {
      files: [],
      source: "none",
      declaredMissing,
      ...(declaredRuntimeEngines.length > 0
        ? { runtimeEngines: declaredRuntimeEngines, runtimeEnginesRecognised: true }
        : {}),
    };
  }

  const ranked = rankedStylesheets(projectRoot);
  let survivor: { file: string; size: number } | undefined;
  for (const candidate of ranked) {
    const relative = path.relative(projectRoot, candidate.file).replace(/\\/g, "/");
    if (rejected.has(candidate.file)) continue;
    if (stylesheetRuleCount(candidate.file) === 0) {
      warningsOut?.push(CSS_PLACEHOLDER_SKIPPED_WARNING(relative));
      continue;
    }
    if (isOptInResetName(candidate.file)) {
      warningsOut?.push(CSS_RESET_SKIPPED_WARNING(relative));
      continue;
    }
    // Preprocessor-missing is not one of the two disqualification checks: it
    // stops the walk (matching the pre-M82 single-candidate behavior) rather
    // than skipping to the next-ranked candidate.
    if (!preprocessorFor(candidate.file, projectRoot, workspaceRoot) && injectable(candidate.file)) {
      survivor = candidate;
    }
    break;
  }

  if (survivor) {
    const relative = path.relative(projectRoot, survivor.file).replace(/\\/g, "/");
    const onlyCandidate = ranked.length === 1;
    const noEntryInPackage = !entry;
    warningsOut?.push(CSS_FALLBACK_WARNING(relative, { onlyCandidate, noEntryInPackage }));
    return { files: [survivor.file], source: "fallback", onlyCandidate, noEntryInPackage };
  }

  const runtimeEngines = detectRuntimeStyleEngines(projectRoot, workspaceRoot);
  if (runtimeEngines.length > 0) {
    return { files: [], source: "runtime", runtimeEngines, runtimeEnginesRecognised: true };
  }

  // M114 A2: no declared engine and no stylesheet anywhere. What the measured
  // file imports is the last read left, and it decides between "none found"
  // and an engine this recogniser cannot name.
  const unlisted = opts?.measuredFile
    ? unrecognisedRuntimeStyleEngine(opts.measuredFile)
    : undefined;
  if (unlisted !== undefined) {
    return {
      files: [],
      source: "runtime",
      runtimeEngines: [unlisted],
      runtimeEnginesRecognised: false,
    };
  }

  return { files: [], source: "none" };
}
