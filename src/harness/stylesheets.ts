import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  findWorkspaceRoot,
  installedPackageDir,
  isPackageAvailable,
  readProjectManifest,
} from "../project/index.js";
import { isFile } from "../shared/index.js";

// Probe order is significant: first hit wins, and detection returns at most one.
// M71: the create-vite name and the Sass spellings are appended, so every path
// that already won still wins.
export const GLOBAL_CSS_CANDIDATES = [
  "app/globals.css",
  "app/global.css",
  "src/app/globals.css",
  "src/app/global.css",
  "src/styles/globals.css",
  "styles/globals.css",
  "src/index.css",
  "src/global.css",
  "src/style.css",
  // M102 (heroui-F1): the plural spelling, one character away from the line
  // above and the name heroui's own `exports["./styles"]` points at.
  "src/styles.css",
  "app/globals.scss",
  "app/global.scss",
  "src/app/globals.scss",
  "src/app/global.scss",
  "src/styles/globals.scss",
  "styles/globals.scss",
  "src/index.scss",
  "src/global.scss",
  "src/style.scss",
];

export function detectGlobalCss(projectRoot: string): string | undefined {
  for (const candidate of GLOBAL_CSS_CANDIDATES) {
    const full = path.join(projectRoot, candidate);
    if (isFile(full)) return full;
  }
  return undefined;
}

export const STYLESHEET_EXTENSIONS = [".css", ".scss", ".sass", ".less", ".styl"];

// Vite fails the whole entry module with "Preprocessor dependency … not found"
// when the compiler is absent, which costs the run rather than the stylesheet.
const PREPROCESSOR_PACKAGES: Record<string, string[]> = {
  ".scss": ["sass", "sass-embedded"],
  ".sass": ["sass", "sass-embedded"],
  ".less": ["less"],
  ".styl": ["stylus"],
};

export function isStylesheet(file: string): boolean {
  return STYLESHEET_EXTENSIONS.includes(path.extname(file).toLowerCase());
}

// A CSS module exports class names; injecting one globally measures a stylesheet
// the application never loads globally.
export function isCssModule(file: string): boolean {
  return /\.module\.[^.]+$/i.test(path.basename(file));
}

// M82: a reset/normalize library's own convention. Opt-in everywhere it
// appears, so the name alone disqualifies it from the largest-stylesheet
// fallback regardless of rule count.
export const RESET_STYLESHEET_STEMS = ["reset", "normalize", "preflight", "sanitize"];

export function isOptInResetName(file: string): boolean {
  const stem = path.basename(file, path.extname(file)).toLowerCase();
  return RESET_STYLESHEET_STEMS.includes(stem);
}

// M82: text-only heuristic, matching the "text only, nothing executed"
// invariant M71 set for readViteConfigData. Strips comments and
// @import/@charset/@use statements, then counts remaining `{` occurrences.
// Zero means the file is a pure passthrough: nothing was ever built into it.
const STYLESHEET_RULE_COUNT_MAX_BYTES = 2 * 1024 * 1024;

export function stylesheetRuleCount(file: string): number {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return 0;
  }
  // Too large to be worth reading this early in the pipeline; a file this big
  // is not an unbuilt placeholder, so it is treated as plausible.
  if (size > STYLESHEET_RULE_COUNT_MAX_BYTES) return 1;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return 0;
  }
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@(?:import|charset|use)\b[^;]*;/gi, "");
  return (stripped.match(/\{/g) ?? []).length;
}

// M102: a stylesheet's own `@import` statements, one hop, at the same text
// level `stylesheetRuleCount` works at — comments stripped, `url()` and quotes
// normalized, a media query or `layer()` suffix and a `?query` dropped. No CSS
// parser (M82's non-goal), and no recursion: one hop answers every shape the
// corpus produced (a passthrough that re-exports a package's real stylesheet,
// and an entry stylesheet importing an unbuilt package subpath).
const STYLESHEET_IMPORT_STATEMENT = /@import\s+(url\(\s*)?("([^"]*)"|'([^']*)')/gi;

export function stylesheetImportSpecifiers(file: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const specifiers: string[] = [];
  STYLESHEET_IMPORT_STATEMENT.lastIndex = 0;
  for (const match of stripped.matchAll(STYLESHEET_IMPORT_STATEMENT)) {
    const raw = (match[3] ?? match[4] ?? "").split("?")[0].trim();
    if (raw) specifiers.push(raw);
  }
  return specifiers;
}

// The three answers a bundler's own resolution can give, kept apart because
// they mean different things to a user: a file to inject, a path the package
// declares and has not produced (shadcn's `dist/tailwind.css`: the run must say
// which build to run), and nothing at all.
export type StylesheetImportTarget = { file: string } | { declared: string } | undefined;

// A bare package root ("@heroui/styles") is not a subpath, so
// resolveBareStylesheetSpecifier declines it by construction. The package's own
// manifest still names its stylesheet, in the same two fields a bundler's
// "style" condition reads.
function packageRootStylesheet(pkg: string, fromDir: string): StylesheetImportTarget {
  const pkgDir = installedPackageDir(pkg, fromDir);
  if (!pkgDir) return undefined;
  const manifest = readProjectManifest(pkgDir);
  if (!manifest) return undefined;
  const dot = manifest.exports && typeof manifest.exports === "object" && !Array.isArray(manifest.exports)
    ? (manifest.exports as Record<string, unknown>)["."]
    : undefined;
  const conditions =
    dot && typeof dot === "object" && !Array.isArray(dot) ? (dot as Record<string, unknown>) : {};
  const declared = [conditions.style, conditions.default, manifest.style].find(
    (value): value is string => typeof value === "string" && isStylesheet(value),
  );
  if (!declared) return undefined;
  const resolved = path.resolve(pkgDir, declared);
  return isFile(resolved) ? { file: resolved } : { declared: resolved };
}

// The lookup order a preprocessor applies to an extension-less import: the
// file itself, its underscore-prefixed partial, and the directory's own index
// partial, per language. Returns undefined when none of them exists — unknown,
// never "missing".
const PREPROCESSOR_PARTIAL_EXTENSIONS = [".scss", ".sass", ".less", ".styl", ".css"];

export function resolvePreprocessorPartial(base: string): string | undefined {
  const dir = path.dirname(base);
  const name = path.basename(base);
  for (const extension of PREPROCESSOR_PARTIAL_EXTENSIONS) {
    const candidates = [
      path.join(dir, name + extension),
      path.join(dir, "_" + name + extension),
      path.join(base, "_index" + extension),
      path.join(base, "index" + extension),
    ];
    for (const candidate of candidates) {
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

export function resolveStylesheetImportTarget(
  specifier: string,
  fromFile: string,
  projectRoot: string,
  aliases: Array<{ find: RegExp; replacement: string }>,
): StylesheetImportTarget {
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return undefined; // http(s):, data:
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const resolved = specifier.startsWith("/")
      ? path.join(projectRoot, specifier)
      : path.resolve(path.dirname(fromFile), specifier);
    if (isFile(resolved)) return { file: resolved };
    // A specifier that names its own extension and is not there really is
    // missing, and the caller may say so (shadcn's `dist/tailwind.css`). An
    // extension-less one is the canonical Sass/Less partial form — ant-design's
    // `@import "../variables"`, primevue's `@import './_mixins'` — where the
    // file on disk is spelled differently by design. Claiming it missing named
    // a path that exists nowhere, which is the exact defect M102's third MUST
    // was written to remove.
    if (isStylesheet(resolved)) return { declared: resolved };
    const partial = resolvePreprocessorPartial(resolved);
    return partial ? { file: partial } : undefined;
  }
  for (const { find, replacement } of aliases) {
    if (!find.test(specifier)) continue;
    const target = path.resolve(specifier.replace(find, replacement));
    if (isFile(target)) return { file: target };
  }
  const fromDir = path.dirname(fromFile);
  const pkg = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
  if (specifier === pkg) return packageRootStylesheet(pkg, fromDir);
  const resolved = resolveBareStylesheetSpecifier(specifier, fromDir);
  if (resolved) return { file: resolved };
  return declaredBareStylesheetTarget(specifier, fromDir);
}

export function preprocessorFor(file: string, memberRoot: string, workspaceRoot: string): string | undefined {
  const packages = PREPROCESSOR_PACKAGES[path.extname(file).toLowerCase()];
  if (!packages) return undefined;
  if (packages.some((pkg) => isPackageAvailable(pkg, memberRoot, workspaceRoot))) return undefined;
  return packages[0];
}

export function CSS_IMPORT_SKIPPED_WARNING(specifiers: string[]): string {
  return (
    `the project entry imports ${specifiers.join(", ")}, which resolved to no file the harness can serve; ` +
    "those stylesheets are not injected and the component may render unstyled"
  );
}

export function CSS_PREPROCESSOR_MISSING_WARNING(file: string, pkg: string): string {
  return (
    `${file} needs ${pkg}, which this project does not have installed; the stylesheet is not injected ` +
    "because Vite would fail the harness entry module instead"
  );
}

// M92 (excalidraw-F6): the pick IS ranked (by size, stated in `scope` below),
// so "no evidence behind it at all" overclaimed when this package has no
// entry of its own -- excalidraw's own case landed on the file the profile
// calls the correct design-token root, ranked there by size alone, not
// arbitrarily. What is actually missing is import-chain corroboration, not
// evidence outright; the low-confidence framing lives in the `Stylesheets:`
// summary line (formatStylesheetsLine, src/report.ts) this warning precedes.
export function CSS_FALLBACK_WARNING(
  relative: string,
  opts: { onlyCandidate: boolean; noEntryInPackage: boolean },
): string {
  const scope = opts.onlyCandidate
    ? "the only stylesheet found under this project"
    : "the largest stylesheet found under this project";
  const entryNote = opts.noEntryInPackage
    ? "; this package has no application entry (index.html or Next.js app/pages stem) of its " +
      "own, so no import chain corroborates the pick -- it is ranked by size alone"
    : "";
  return (
    `no entry stylesheet import and no conventional global stylesheet were found, so ${relative} ` +
    `was injected because it is ${scope}${entryNote}; pass --css to name the right one`
  );
}

// M82: a fallback candidate with rule count 0 was never built into anything
// the project would load as-is.
// M92 (dub-F2): rule count 0 means no brace-delimited rule survives stripping
// comments and @import/@charset/@use -- it does not mean the file's only
// content IS comments and imports. A pure `@tailwind base;`/`@tailwind
// components;`/`@tailwind utilities;` passthrough (three at-rules, zero
// comments, zero imports) also counts 0, so the old fixed claim was false for
// exactly that shape; this names what the count actually proves instead.
export function CSS_PLACEHOLDER_SKIPPED_WARNING(relative: string): string {
  return (
    `${relative} contains no CSS rule with a body of its own (comments, imports, and bare at-rules ` +
    "such as @tailwind don't count), so it was not used as the stylesheet fallback: an unbuilt " +
    "passthrough is not something the project would load as-is"
  );
}

// M82: a reset/normalize stylesheet is conventionally opt-in; a project that
// imports it deliberately reaches it through the entry layer and never falls
// this far.
export function CSS_RESET_SKIPPED_WARNING(relative: string): string {
  return (
    `${relative} looks like an opt-in reset/normalize stylesheet (by filename), so it was not used as ` +
    "the stylesheet fallback: those are conventionally imported deliberately, not auto-injected"
  );
}

export function CSS_DROPPED_WARNING(file: string): string {
  return (
    `auto-detected stylesheet ${file} does not exist and was dropped; an unresolvable import would have ` +
    "failed the whole harness entry module"
  );
}

// M71: only --css validated its input, and a specifier that resolves to nothing
// takes the entry module down with it. Every auto-detected path passes here.
export function validateCssFiles(files: string[], warningsOut?: string[]): string[] {
  const kept: string[] = [];
  for (const file of files) {
    if (isFile(file)) kept.push(file);
    else warningsOut?.push(CSS_DROPPED_WARNING(file));
  }
  return kept;
}

// M92 (twenty-F3): a bare package specifier ("twenty-ui/theme-light.css") is a
// real, resolvable stylesheet whenever the package's own exports map (or, in
// its absence, a plain directory join) names that subpath -- exactly the
// resolution a real bundler performs. A package can export some subpaths and
// not others, so this always resolves one full specifier's real status, never
// a whole batch's: the caller can tell a genuinely-missing file from one that
// resolves fine.
function resolveBareStylesheetSpecifier(specifier: string, fromDir: string): string | undefined {
  const target = bareStylesheetTarget(specifier, fromDir);
  return target && "file" in target ? target.file : undefined;
}

// M102: the same resolution, reporting a declared-but-absent target instead of
// discarding it. shadcn's `shadcn/tailwind.css` resolves through the package's
// own exports map to `dist/tailwind.css`, a directory that exists only after
// that package is built: a user needs that path named, not the specifier
// pasted onto a repository root.
function declaredBareStylesheetTarget(specifier: string, fromDir: string): StylesheetImportTarget {
  const target = bareStylesheetTarget(specifier, fromDir);
  return target && "declared" in target ? target : undefined;
}

function bareStylesheetTarget(specifier: string, fromDir: string): StylesheetImportTarget {
  const pkg = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
  const subpath = specifier.slice(pkg.length + 1);
  if (!subpath) return undefined;
  const pkgDir = installedPackageDir(pkg, fromDir);
  if (!pkgDir) return undefined;
  const exportsField = readProjectManifest(pkgDir)?.exports;
  if (exportsField && typeof exportsField === "object" && !Array.isArray(exportsField)) {
    const entry = (exportsField as Record<string, unknown>)[`./${subpath}`];
    const target =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && !Array.isArray(entry)
          ? ["default", "import", "require", "style"]
              .map((condition) => (entry as Record<string, unknown>)[condition])
              .find((value): value is string => typeof value === "string")
          : undefined;
    if (!target) return undefined;
    const resolved = path.resolve(pkgDir, target);
    return isFile(resolved) ? { file: resolved } : { declared: resolved };
  }
  const direct = path.resolve(pkgDir, subpath);
  return isFile(direct) ? { file: direct } : { declared: direct };
}

function resolveStylesheetSpecifier(
  specifier: string,
  entryFile: string,
  projectRoot: string,
  aliases: Array<{ find: RegExp; replacement: string }>,
): string | undefined {
  if (specifier.startsWith(".")) {
    const resolved = path.resolve(path.dirname(entryFile), specifier);
    return isFile(resolved) ? resolved : undefined;
  }
  if (specifier.startsWith("/")) {
    const resolved = path.join(projectRoot, specifier);
    return isFile(resolved) ? resolved : undefined;
  }
  for (const { find, replacement } of aliases) {
    if (!find.test(specifier)) continue;
    const target = path.resolve(specifier.replace(find, replacement));
    if (isFile(target)) return target;
  }
  return resolveBareStylesheetSpecifier(specifier, path.dirname(entryFile));
}

// The entry's own side-effect stylesheet imports, in import order. A bound
// import (`import styles from "./x.module.css"`) is a CSS module read, not a
// global stylesheet, and a deeper walk is out of scope: the file the project
// starts from is where a global stylesheet is loaded.
export function entryStylesheetImports(
  entryFile: string,
  projectRoot: string,
  aliases: Array<{ find: RegExp; replacement: string }>,
  warningsOut?: string[],
  workspaceRoot: string = findWorkspaceRoot(projectRoot),
): string[] {
  let sourceText: string;
  try {
    sourceText = fs.readFileSync(entryFile, "utf-8");
  } catch {
    return [];
  }
  const kind = /\.[jt]sx$/i.test(entryFile) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(entryFile, sourceText, ts.ScriptTarget.Latest, false, kind);

  const files: string[] = [];
  const unresolved: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text.split("?")[0];
    if (!specifier || !isStylesheet(specifier) || isCssModule(specifier)) continue;
    const resolved = resolveStylesheetSpecifier(specifier, entryFile, projectRoot, aliases);
    if (!resolved) {
      unresolved.push(specifier);
      continue;
    }
    const missing = preprocessorFor(resolved, projectRoot, workspaceRoot);
    if (missing) {
      warningsOut?.push(CSS_PREPROCESSOR_MISSING_WARNING(resolved, missing));
      continue;
    }
    if (!files.includes(resolved)) files.push(resolved);
  }
  if (unresolved.length > 0) warningsOut?.push(CSS_IMPORT_SKIPPED_WARNING(unresolved));
  return files;
}
