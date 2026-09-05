import fs from "node:fs";
import path from "node:path";
import {
  findWorkspaceRoot,
  loadTsconfigAliases,
  readProjectManifest,
} from "../project/index.js";
import { packageScriptCommand } from "./bundler-failure.js";
import {
  detectRuntimeStyleEngines,
  installedTailwindVersion,
  unrecognisedRuntimeStyleEngine,
} from "./style-tooling.js";
import {
  CSS_FALLBACK_WARNING,
  CSS_TAILWIND_SYNTAX_MISMATCH_WARNING,
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
  stylesheetTailwindSyntax,
  validateCssFiles,
} from "./stylesheets.js";
import { readViteConfigData } from "./vite-config.js";
import { isFile, toPosix } from "../shared/index.js";

const NEXT_ENTRY_STEMS = ["app/layout", "src/app/layout", "pages/_app", "src/pages/_app"];
const ENTRY_EXTENSIONS = [".tsx", ".jsx", ".ts", ".js"];
const MODULE_SCRIPT_TAG = /<script\b[^>]*>/gi;

// rootDir is Vite's own `root`, which is the package root only when the config declares none.
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

// The module the project's own toolchain starts from: index.html's, or Next.js's route entry.
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

// Bounded walk: a repository is big and this runs before anything is measured.
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
  // Ties break on path, so one project always yields one answer whatever the walk order.
  return found.sort((a, b) => b.size - a.size || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

// Last resort. Ties break on path so one project always yields one answer.
export function largestStylesheet(projectRoot: string): string | undefined {
  return rankedStylesheets(projectRoot)[0]?.file;
}

export interface CssDiscovery {
  files: string[];
  // "package-declared" is evidence the package published, not a conventional filename.
  source: "entry" | "package-declared" | "candidate" | "fallback" | "runtime" | "none";
  // present only when source === "fallback"
  onlyCandidate?: boolean;
  noEntryInPackage?: boolean;
  // Present for "runtime", and on the "none" of a declared-but-unbuilt stylesheet.
  runtimeEngines?: string[];
  // False means a styling binding from a package RUNTIME_STYLE_ENGINES does not carry.
  runtimeEnginesRecognised?: boolean;
  // Present only when `source` is "none": the declaration stopped the size-ranked fallback.
  declaredMissing?: Array<{ field: string; path: string; buildCommand?: string }>;
}

// A package that names its own stylesheet and has not built it reads differently from none.
export type PackageStylesheetCandidate = { file: string } | { declared: string; field: string };

// Only the measured package's own manifest, never an ancestor application's.
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

// A remedy quotes a build script the manifest declares, or none at all.
export function CSS_DECLARED_UNBUILT_WARNING(
  declarations: Array<{ field: string; path: string }>,
  buildCommand?: string,
  // A package that also styles at runtime is not measured unstyled; name the engines instead.
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

// A 0-rule passthrough stands for the stylesheet it imports, so that one gets injected.
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
  return toPosix(path.relative(projectRoot, file));
}

// A stylesheet that reads fine can still fail to compile because an import does not exist.
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

// Evidence before convention: a filename list is a guess, and the size-ranked walk says so.
export function discoverGlobalCss(
  projectRoot: string,
  warningsOut?: string[],
  // A wrapper is no application entry, so it never changes `noEntryInPackage`.
  opts?: { extraEntryFiles?: string[]; measuredFile?: string },
): CssDiscovery {
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  const aliases = loadTsconfigAliases(projectRoot);
  // A file rejected by one layer stays rejected: re-picking it would undo the disclosure.
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

  // A guessed candidate whose dialect the installed Tailwind cannot compile is not this app's sheet.
  const tailwindVersion = installedTailwindVersion(projectRoot, workspaceRoot);
  const tailwindInstalledMajor = Number(/(\d+)/.exec(tailwindVersion ?? "")?.[1]);
  const contradictsInstalledTailwind = (file: string): boolean => {
    if (tailwindVersion === undefined || Number.isNaN(tailwindInstalledMajor)) return false;
    const syntax = stylesheetTailwindSyntax(file);
    if (syntax === undefined || syntax === tailwindInstalledMajor) return false;
    rejected.add(file);
    warningsOut?.push(
      CSS_TAILWIND_SYNTAX_MISMATCH_WARNING(
        relativeToRoot(file, projectRoot),
        syntax,
        tailwindVersion,
      ),
    );
    return true;
  };

  // The config decides where index.html is: a declared `root`, or a foldable rollup input.
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

  // What the package says about itself, above a filename convention and the size-ranked guess.
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
    // A filename convention is a guess; a manifest declaration is the package's own statement.
    if (source === "candidate" && contradictsInstalledTailwind(candidate)) continue;
    if (!injectable(candidate)) continue;
    const files = expandPassthroughStylesheet(candidate, projectRoot, aliases, warningsOut).filter(
      injectable,
    );
    if (files.length === 0) {
      // Recorded as rejected so the ranked walk below skips it instead of warning twice.
      if (stylesheetRuleCount(candidate) === 0) {
        rejected.add(candidate);
        warningsOut?.push(CSS_PLACEHOLDER_SKIPPED_WARNING(relativeToRoot(candidate, projectRoot)));
      }
      continue;
    }
    return { files, source };
  }

  // A package that declares a stylesheet and has not built it is not a package without one.
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
    // Asked here because this return skips the runtime layer below the ranked walk.
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
    const relative = toPosix(path.relative(projectRoot, candidate.file));
    if (rejected.has(candidate.file)) continue;
    if (stylesheetRuleCount(candidate.file) === 0) {
      warningsOut?.push(CSS_PLACEHOLDER_SKIPPED_WARNING(relative));
      continue;
    }
    if (isOptInResetName(candidate.file)) {
      warningsOut?.push(CSS_RESET_SKIPPED_WARNING(relative));
      continue;
    }
    if (contradictsInstalledTailwind(candidate.file)) continue;
    // Preprocessor-missing stops the walk rather than skipping to the next-ranked candidate.
    if (!preprocessorFor(candidate.file, projectRoot, workspaceRoot) && injectable(candidate.file)) {
      survivor = candidate;
    }
    break;
  }

  if (survivor) {
    const relative = toPosix(path.relative(projectRoot, survivor.file));
    const onlyCandidate = ranked.length === 1;
    const noEntryInPackage = !entry;
    warningsOut?.push(CSS_FALLBACK_WARNING(relative, { onlyCandidate, noEntryInPackage }));
    return { files: [survivor.file], source: "fallback", onlyCandidate, noEntryInPackage };
  }

  const runtimeEngines = detectRuntimeStyleEngines(projectRoot, workspaceRoot);
  if (runtimeEngines.length > 0) {
    return { files: [], source: "runtime", runtimeEngines, runtimeEnginesRecognised: true };
  }

  // The measured file's own imports decide between "none found" and an unnameable engine.
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
