import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  bundledPreprocessor,
  findWorkspaceRoot,
  installedPackageDir,
  isPackageAvailable,
  readProjectManifest,
} from "../project/index.js";
import { isFile } from "../shared/index.js";

// Probe order is significant: first hit wins, and detection returns at most one.
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
  // The plural spelling heroui's own `exports["./styles"]` points at.
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

// Without the compiler, Vite fails the whole entry module: the run, not just the stylesheet.
const PREPROCESSOR_PACKAGES: Record<string, string[]> = {
  ".scss": ["sass", "sass-embedded"],
  ".sass": ["sass", "sass-embedded"],
  ".less": ["less"],
  ".styl": ["stylus"],
};

export function isStylesheet(file: string): boolean {
  return STYLESHEET_EXTENSIONS.includes(path.extname(file).toLowerCase());
}

// The at-rules that only exist in one Tailwind major, so a file states which one wrote it.
const TAILWIND4_SYNTAX =
  /@import\s+["']tailwindcss(?:\/[^"']*)?["']|@(?:theme|utility|custom-variant|plugin|source|reference)\b/;
const TAILWIND3_SYNTAX = /@tailwind\s+(?:base|components|utilities|screens|variants)\b/;

// Undefined when the file names neither dialect, and when it names both: neither is a contradiction.
export function stylesheetTailwindSyntax(file: string): 3 | 4 | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
  const four = TAILWIND4_SYNTAX.test(text);
  const three = TAILWIND3_SYNTAX.test(text);
  if (four === three) return undefined;
  return four ? 4 : 3;
}

export function CSS_TAILWIND_SYNTAX_MISMATCH_WARNING(
  relative: string,
  syntaxMajor: 3 | 4,
  installedVersion: string,
): string {
  return (
    `${relative} was written for Tailwind ${syntaxMajor}, but this project has tailwindcss ` +
    `${installedVersion} installed, so it is not a stylesheet this project's own build compiles; ` +
    "it was not used as the stylesheet fallback. Pass --css to name the right one"
  );
}

// A CSS module exports class names; injecting it globally measures a sheet nothing loads.
export function isCssModule(file: string): boolean {
  return /\.module\.[^.]+$/i.test(path.basename(file));
}

// Opt-in by convention, so the name alone disqualifies it from the largest-sheet fallback.
export const RESET_STYLESHEET_STEMS = ["reset", "normalize", "preflight", "sanitize"];

// `_name.scss` is a Sass partial: the compiler refuses to emit it as a stylesheet of its own.
export function isPreprocessorPartialName(file: string): boolean {
  return path.basename(file).startsWith("_") && path.extname(file).toLowerCase() !== ".css";
}

export function isOptInResetName(file: string): boolean {
  const stem = path.basename(file, path.extname(file)).toLowerCase();
  return RESET_STYLESHEET_STEMS.includes(stem);
}

const STYLESHEET_RULE_COUNT_MAX_BYTES = 2 * 1024 * 1024;

// Zero braces means a pure passthrough: nothing was ever built into the file.
export function stylesheetRuleCount(file: string): number {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return 0;
  }
  // A file this big is not an unbuilt placeholder, so it is treated as plausible.
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

// One hop and no CSS parser: no shape the corpus produced needs recursion.
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

// The declared case is kept apart: a user must be told which build produces that path.
export type StylesheetImportTarget = { file: string } | { declared: string } | undefined;

// A bare package root is not a subpath, so resolveBareStylesheetSpecifier declines it.
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

const PREPROCESSOR_PARTIAL_EXTENSIONS = [".scss", ".sass", ".less", ".styl", ".css"];

// A preprocessor also accepts the underscore partial and the directory's own index partial.
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
    // A specifier that names its own extension and is not there really is missing.
    if (isStylesheet(resolved)) return { declared: resolved };
    // Extension-less is the canonical Sass/Less partial form, spelled differently on disk.
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

// Undefined means the sheet compiles: with the project's own implementation, or with the one
// 120fps declares itself, which Vite's own fallback search base resolves.
export function preprocessorFor(file: string, memberRoot: string, workspaceRoot: string): string | undefined {
  const extension = path.extname(file).toLowerCase();
  const packages = PREPROCESSOR_PACKAGES[extension];
  if (!packages) return undefined;
  if (packages.some((pkg) => isPackageAvailable(pkg, memberRoot, workspaceRoot))) return undefined;
  if (bundledPreprocessor(extension)) return undefined;
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

// The pick is ranked by size, so what is missing is import-chain corroboration, not evidence.
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

// Rule count 0 does not mean comments-only: a pure @tailwind passthrough also counts 0.
export function CSS_PLACEHOLDER_SKIPPED_WARNING(relative: string): string {
  return (
    `${relative} contains no CSS rule with a body of its own (comments, imports, and bare at-rules ` +
    "such as @tailwind don't count), so it was not used as the stylesheet fallback: an unbuilt " +
    "passthrough is not something the project would load as-is"
  );
}

// A project that imports a reset deliberately reaches it through the entry layer.
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

// Auto-detected paths are unvalidated, and one that resolves to nothing kills the entry.
export function validateCssFiles(files: string[], warningsOut?: string[]): string[] {
  const kept: string[] = [];
  for (const file of files) {
    if (isFile(file)) kept.push(file);
    else warningsOut?.push(CSS_DROPPED_WARNING(file));
  }
  return kept;
}

// One full specifier at a time: a package can export some subpaths and not others.
function resolveBareStylesheetSpecifier(specifier: string, fromDir: string): string | undefined {
  const target = bareStylesheetTarget(specifier, fromDir);
  return target && "file" in target ? target.file : undefined;
}

// A declared target inside an unbuilt dist/ must be named, not pasted onto a repository root.
function declaredBareStylesheetTarget(specifier: string, fromDir: string): StylesheetImportTarget {
  const target = bareStylesheetTarget(specifier, fromDir);
  return target && "declared" in target ? target : undefined;
}

// One target per exports entry: a string, or the first condition that names a file.
function exportsTargetFile(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return undefined;
  if (Array.isArray(entry)) {
    for (const alternative of entry) {
      const target = exportsTargetFile(alternative);
      if (target) return target;
    }
    return undefined;
  }
  const conditions = entry as Record<string, unknown>;
  for (const condition of ["style", "default", "import", "require", "sass"]) {
    const target = exportsTargetFile(conditions[condition]);
    if (target) return target;
  }
  return undefined;
}

// Node's own pattern specificity: longest prefix before the star, then longest suffix after it.
function patternSpecificity(key: string): [number, number] {
  const star = key.indexOf("*");
  return [star, key.length - star - 1];
}

// An exact key wins; otherwise the most specific `*` pattern the subpath matches decides.
export function resolveExportsSubpath(exportsField: unknown, subpath: string): string | undefined {
  if (!exportsField || typeof exportsField !== "object" || Array.isArray(exportsField)) {
    return undefined;
  }
  const entries = exportsField as Record<string, unknown>;
  const exact = exportsTargetFile(entries[`./${subpath}`]);
  if (exact) return exact;

  let best: { target: string; specificity: [number, number] } | undefined;
  for (const [key, entry] of Object.entries(entries)) {
    if (!key.startsWith("./") || key.indexOf("*") !== key.lastIndexOf("*") || !key.includes("*")) {
      continue;
    }
    const [prefix, suffix] = key.slice(2).split("*");
    if (subpath.length < prefix.length + suffix.length) continue;
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    const template = exportsTargetFile(entry);
    if (!template || !template.includes("*")) continue;
    const wildcard = subpath.slice(prefix.length, subpath.length - suffix.length);
    const specificity = patternSpecificity(key);
    if (best && (best.specificity[0] > specificity[0] ||
      (best.specificity[0] === specificity[0] && best.specificity[1] >= specificity[1]))) {
      continue;
    }
    best = { target: template.split("*").join(wildcard), specificity };
  }
  return best?.target;
}

function bareStylesheetTarget(specifier: string, fromDir: string): StylesheetImportTarget {
  const pkg = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
  const subpath = specifier.slice(pkg.length + 1);
  if (!subpath) return undefined;
  const pkgDir = installedPackageDir(pkg, fromDir);
  if (!pkgDir) return undefined;
  const target = resolveExportsSubpath(readProjectManifest(pkgDir)?.exports, subpath);
  if (target) {
    const resolved = path.resolve(pkgDir, target);
    if (isFile(resolved)) return { file: resolved };
    // A pattern can name a file a build produces; the file on disk still decides.
    const direct = path.resolve(pkgDir, subpath);
    return isFile(direct) ? { file: direct } : { declared: resolved };
  }
  // No key and no pattern matched: the package still ships the file at its own path.
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

// An SFC's imports live in its script block; its <style> block is compiled with the component.
const SFC_SCRIPT_BLOCK = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
const ENTRY_SOURCE_MAX_BYTES = 4 * 1024 * 1024;

interface EntryImport {
  specifier: string;
  bound: boolean;
}

// One parse per module, so an entry and a module one hop below it read the same way.
function moduleImports(file: string): EntryImport[] {
  let sourceText: string;
  try {
    if (fs.statSync(file).size > ENTRY_SOURCE_MAX_BYTES) return [];
    sourceText = fs.readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  let kind = /\.[jt]sx$/i.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  if (/\.vue$/i.test(file)) {
    SFC_SCRIPT_BLOCK.lastIndex = 0;
    sourceText = [...sourceText.matchAll(SFC_SCRIPT_BLOCK)].map((match) => match[1]).join("\n");
    kind = ts.ScriptKind.TS;
  }
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, false, kind);
  const imports: EntryImport[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text.split("?")[0];
    if (specifier) imports.push({ specifier, bound: statement.importClause !== undefined });
  }
  return imports;
}

const MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs", ".cts", ".vue"];
// The entry's own imports are followed one level; a whole module graph is not this layer's job.
const MAX_HOP_MODULES = 32;

function resolveModuleFile(base: string): string | undefined {
  if (isFile(base) && MODULE_EXTENSIONS.includes(path.extname(base).toLowerCase())) return base;
  for (const extension of MODULE_EXTENSIONS) {
    if (isFile(base + extension)) return base + extension;
  }
  for (const extension of MODULE_EXTENSIONS) {
    const index = path.join(base, "index" + extension);
    if (isFile(index)) return index;
  }
  return undefined;
}

function within(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// The modules the entry itself loads, from this project's own sources: the one hop the walk takes.
export function entryModuleImports(
  entryFile: string,
  projectRoot: string,
  aliases: Array<{ find: RegExp; replacement: string }>,
): string[] {
  const found: string[] = [];
  for (const { specifier } of moduleImports(entryFile)) {
    if (found.length >= MAX_HOP_MODULES) break;
    if (isStylesheet(specifier)) continue;
    let base: string | undefined;
    if (specifier.startsWith(".")) base = path.resolve(path.dirname(entryFile), specifier);
    else if (specifier.startsWith("/")) base = path.join(projectRoot, specifier);
    else {
      for (const { find, replacement } of aliases) {
        if (!find.test(specifier)) continue;
        base = path.resolve(specifier.replace(find, replacement));
        break;
      }
    }
    if (!base) continue;
    const resolved = resolveModuleFile(base);
    if (!resolved) continue;
    if (!within(projectRoot, resolved) || resolved.split(path.sep).includes("node_modules")) continue;
    if (!found.includes(resolved) && resolved !== path.resolve(entryFile)) found.push(resolved);
  }
  return found;
}

// A stylesheet import is global whether it binds a name (`./app.css?url`) or not; a CSS module
// import is a class-name read, and an extensionless specifier counts only when it lands on a sheet.
export function entryStylesheetImports(
  entryFile: string,
  projectRoot: string,
  aliases: Array<{ find: RegExp; replacement: string }>,
  warningsOut?: string[],
  workspaceRoot: string = findWorkspaceRoot(projectRoot),
): string[] {
  const files: string[] = [];
  const unresolved: string[] = [];
  for (const { specifier, bound } of moduleImports(entryFile)) {
    if (isCssModule(specifier)) continue;
    let resolved: string | undefined;
    if (isStylesheet(specifier)) {
      resolved = resolveStylesheetSpecifier(specifier, entryFile, projectRoot, aliases);
      if (!resolved) {
        unresolved.push(specifier);
        continue;
      }
    } else {
      // A bound import with no stylesheet extension reads a module's exports, never a sheet.
      if (bound) continue;
      const target = resolveStylesheetImportTarget(specifier, entryFile, projectRoot, aliases);
      if (!target || !("file" in target) || !isStylesheet(target.file)) continue;
      resolved = target.file;
    }
    if (isCssModule(resolved)) continue;
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
