import { createServer, searchForWorkspaceRoot, type ViteDevServer } from "vite";
import ts from "typescript";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { CompositionTree, CompositionNode, ExportInfo } from "./composition.js";
import { scanExports, normalizeComponentName } from "./prop-gen.js";
import { isVueFile, loadVueCompiler, type VueSfcCompiler } from "./vue-sfc.js";
import {
  findCompilerConfig,
  findProjectRoot,
  findWorkspaceRoot,
  isPackageAvailable,
  isPackageDeclared,
  workspaceLevels,
} from "./project-model.js";

export { findProjectRoot };

// M57. The measured file's own extension decides how it is mounted: a `.vue`
// SFC cannot be rendered by React and a `.tsx` cannot be rendered by Vue, so
// this is stronger evidence than anything in package.json.
export type Renderer = "react" | "vue";

export function rendererFor(filePath: string): Renderer {
  return isVueFile(filePath) ? "vue" : "react";
}

// An SFC's component is its default export and has no exported name, so the
// entry's import binding is derived from the filename. Vue's own convention is
// kebab-case files, which is not an identifier: `my-button.vue` must not
// generate `import My-button`.
export function vueComponentName(filePath: string): string {
  const stem = path.basename(filePath, path.extname(filePath));
  const name = stem
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return /^[A-Za-z_$]/.test(name) ? name : `Component${name}`;
}

export interface ShimEntry {
  module: string;
  shimFile: string;
}

export const SHIM_MODULES: ShimEntry[] = [
  { module: "next/image", shimFile: "next-image.js" },
  { module: "next/dynamic", shimFile: "next-dynamic.js" },
  { module: "next/link", shimFile: "next-link.js" },
  { module: "next/navigation", shimFile: "next-navigation.js" },
  { module: "next/headers", shimFile: "next-headers.js" },
  { module: "next/script", shimFile: "next-script.js" },
  { module: "next/head", shimFile: "next-head.js" },
  { module: "next/router", shimFile: "next-router.js" },
  { module: "next/font/local", shimFile: "next-font-local.js" },
  { module: "next-video/player", shimFile: "next-video-player.js" },
];

// M73: everything else under `next/` resolves from the project's own Next
// install, where a module written for the server or for the compiler plugin can
// fail to load in a plain browser. Named rather than blocked: it may work.
// `next/font/google` is here permanently, not by omission: each font family is
// a separate named export, the set is unbounded, and a browser rejects a named
// import its target module does not provide, so no static shim can answer it.
export function unshimmedNextModules(specifiers: Iterable<string>): string[] {
  const shimmed = new Set(SHIM_MODULES.map((entry) => entry.module));
  const unshimmed = new Set<string>();
  for (const spec of specifiers) {
    if (spec.startsWith("next/") && !shimmed.has(spec)) unshimmed.add(spec);
  }
  return [...unshimmed].sort();
}

export function UNSUPPORTED_NEXT_MODULE_WARNING(modules: string[]): string {
  return (
    `${modules.join(", ")} ${modules.length === 1 ? "is" : "are"} imported but not shimmed; ` +
    "120fps replaces the Next.js runtime modules it can render standalone and leaves the rest to " +
    "resolve from the project, where a module written for the Next.js server or its compiler " +
    "plugin can fail to load in the harness page"
  );
}

export function detectNextJs(projectRoot: string): boolean {
  return isPackageAvailable("next", projectRoot);
}

export function buildShimAliases(
  hasNextJs: boolean,
): Array<{ find: RegExp; replacement: string; isShim: boolean }> {
  if (!hasNextJs) return [];
  const shimDir = path.resolve(import.meta.dirname ?? __dirname, "shims");
  return SHIM_MODULES.map((entry) => {
    const escaped = entry.module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return {
      find: new RegExp(`^${escaped}$`),
      replacement: path.join(shimDir, entry.shimFile),
      isShim: true,
    };
  });
}

export interface ComponentIdentity {
  relative: string;
  name: string;
  isDefaultExport: boolean;
}

export interface HarnessResult {
  url: string;
  server: ViteDevServer;
  componentPath: string;
  harnessDir: string;
  cleanup: () => Promise<void>;
  component: ComponentIdentity;
  nextJsShims?: string[];
  wrapPath?: string;
  wrapRelative?: string;
  cssFiles?: string[];
  reactCompiler?: ReactCompilerState;
  // M38: build-time advisories (e.g. a shared server whose frozen dep list
  // misses this component's scan). analyze() forwards them to the report.
  warnings?: string[];
}

// M38: the dev server's root is projectRoot and every harness dir lives under
// it, so one server per config tuple serves a whole sweep. Vite serves files
// created after boot on demand: later components need no restart.
export interface ServerPool {
  acquire(
    key: string,
    boot: () => Promise<ViteDevServer>,
    include: string[],
  ): Promise<{ server: ViteDevServer; reused: boolean; include: Set<string> }>;
  stats(): { booted: number };
  closeAll(): Promise<void>;
}

export function createServerPool(): ServerPool {
  // M56: once per session, best-effort: errors are swallowed inside the
  // sweep itself, so this can never fail or block pool creation.
  sweepStaleTmpDirs();
  const servers = new Map<string, Promise<{ server: ViteDevServer; include: Set<string> }>>();
  let closed = false;
  let booted = 0;
  return {
    async acquire(key, boot, include) {
      if (closed) throw new Error("server pool is closed");
      let entry = servers.get(key);
      let reused = true;
      if (!entry) {
        reused = false;
        booted++;
        // The include list is frozen at first boot: it is part of the Vite
        // config hash, and changing it per component would force a dep
        // re-bundle for every component of the sweep (M34).
        entry = boot().then((server) => ({ server, include: new Set(include) }));
        servers.set(key, entry);
      }
      const resolved = await entry;
      return { server: resolved.server, reused, include: resolved.include };
    },
    stats: () => ({ booted }),
    async closeAll() {
      closed = true;
      for (const entry of servers.values()) {
        try {
          await (await entry).server.close();
        } catch {
          // Already closed, or boot failed: nothing left to release.
        }
      }
      servers.clear();
    },
  };
}

export function SWEEP_DEP_WARNING(missing: string[]): string {
  return (
    `shared sweep server was booted without ${missing.join(", ")} in its optimized deps; ` +
    "Vite discovers them on demand, which can reload the page once mid-run (retried automatically)"
  );
}

// M56: names both the cause (whatever Vite or the address check reported) and
// where: the one detail that turns "something failed" into something a user
// can act on (check the harness dir, or the underlying message, for why).
export function VITE_START_FAILED(harnessDir: string, detail: string): string {
  return `Failed to start Vite dev server in ${harnessDir}: ${detail}`;
}

// M73: the harness dir is created inside the project root by design (Vite's
// root is the project root, so the generated entry's root-absolute specifiers,
// the project's aliases, and its node_modules walk all resolve the way the app
// resolves them). A root that cannot be written to is therefore a refusal, and
// the raw EACCES that mkdtempSync throws says none of that.
export function HARNESS_DIR_UNWRITABLE(projectRoot: string, detail: string): string {
  return (
    `Cannot create the harness directory in ${projectRoot}: ${detail}. ` +
    "120fps writes its generated entry inside the project root so the project's own aliases and " +
    "node_modules resolve the way the app resolves them. Make that directory writable, or copy " +
    "the project to a writable location and measure it there."
  );
}

// accessSync answers POSIX permission bits; the real mkdtempSync answers
// everything it cannot see (Windows ACLs, a read-only mount, a root that is a
// file or does not exist).
export function createHarnessDir(projectRoot: string): string {
  const fail = (err: unknown): never => {
    throw new Error(
      HARNESS_DIR_UNWRITABLE(projectRoot, err instanceof Error ? err.message : String(err)),
      { cause: err },
    );
  };
  try {
    fs.accessSync(projectRoot, fs.constants.W_OK);
  } catch (err) {
    return fail(err);
  }
  try {
    return fs.mkdtempSync(path.join(projectRoot, ".120fps-harness-"));
  } catch (err) {
    return fail(err);
  }
}

// M73: the version is read from the project's own react-dom rather than
// resolveReactDomIdentity in src/react-profiler.ts, which imports values from
// this module: the reverse import would close a cycle.
function readReactDomVersion(projectRoot: string): string | undefined {
  try {
    const pkgPath = createRequire(path.join(projectRoot, "/")).resolve("react-dom/package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

export function REACT_DOM_CLIENT_MISSING(projectRoot: string, version: string | undefined): string {
  return (
    `React 18+ required${version ? ` (found react-dom v${version})` : ""}: ` +
    `react-dom/client does not resolve from ${projectRoot}. The harness mounts with createRoot ` +
    "from react-dom/client, which React 16 and 17 do not provide. Upgrade react-dom in the " +
    "project, or measure the component from a project on React 18 or newer."
  );
}

// Checked before the server boots: react-dom/client is forced into
// optimizeDeps.include for every React run, and an unresolvable include aborts
// Vite's optimizer with an esbuild path dump instead of a version diagnosis.
export function assertReactDomClient(projectRoot: string): void {
  try {
    createRequire(path.join(projectRoot, "/")).resolve("react-dom/client");
  } catch {
    throw new Error(REACT_DOM_CLIENT_MISSING(projectRoot, readReactDomVersion(projectRoot)));
  }
}

// M73: path.win32.relative("C:\\proj", "D:\\x") returns "D:\\x" — two drives
// have no common ancestor to walk up to, so the result is absolute and carries
// no "..". A caller reading only the "../" prefix takes another drive for an
// in-root path. The platform parameter makes the drive-letter behavior
// observable from a test on any host.
export function isOutsideRoot(
  target: string,
  root: string,
  platform: path.PlatformPath = path,
): boolean {
  const relative = platform.relative(root, target);
  return (
    relative === ".." || relative.startsWith(".." + platform.sep) || platform.isAbsolute(relative)
  );
}

// The body of the entry's import specifier: the generators embed it as
// `from "/${componentRelative}"`, so an out-of-root component becomes
// "/@fs/<posix-absolute>", the same escape hatch cssImportSpecifier already
// uses for an out-of-root stylesheet.
export function componentImportPath(
  componentPath: string,
  projectRoot: string,
  platform: path.PlatformPath = path,
): string {
  if (isOutsideRoot(componentPath, projectRoot, platform)) {
    return "@fs/" + componentPath.replace(/\\/g, "/").replace(/^\//, "");
  }
  return platform.relative(projectRoot, componentPath).replace(/\\/g, "/");
}

export interface BuildHarnessOptions {
  composition?: CompositionTree;
  exports?: ExportInfo[];
  noShims?: boolean;
  wrapPath?: string;
  cssFiles?: string[];
  reactCompiler?: boolean;
  // M38: reuse one dev server per config tuple across a sweep.
  serverPool?: ServerPool;
  // M44: absolute path to a `<stem>.props.tsx` preset module, imported by the
  // entry so non-serializable preset values resolve in the page.
  presetPath?: string;
  // M48: skip the project's own Vite transforms (measure what the harness can
  // compile on its own).
  noTransforms?: boolean;
  // M65: the export named by `<file>#Export`, imported instead of the one the
  // selection order would pick.
  target?: string;
}

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
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch {
      // missing or unreadable: try the next candidate
    }
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

function isStylesheet(file: string): boolean {
  return STYLESHEET_EXTENSIONS.includes(path.extname(file).toLowerCase());
}

// A CSS module exports class names; injecting one globally measures a stylesheet
// the application never loads globally.
function isCssModule(file: string): boolean {
  return /\.module\.[^.]+$/i.test(path.basename(file));
}

function preprocessorFor(file: string, memberRoot: string, workspaceRoot: string): string | undefined {
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

export function CSS_FALLBACK_WARNING(relative: string): string {
  return (
    `no entry stylesheet import and no conventional global stylesheet were found, so ${relative} was ` +
    "injected because it is the largest stylesheet in the project; pass --css to name the right one"
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

const NEXT_ENTRY_STEMS = ["app/layout", "src/app/layout", "pages/_app", "src/pages/_app"];
const ENTRY_EXTENSIONS = [".tsx", ".jsx", ".ts", ".js"];
const MODULE_SCRIPT_TAG = /<script\b[^>]*>/gi;

// The module the project's own toolchain starts from: what index.html loads, or
// the module Next.js renders every route through.
export function findProjectEntry(projectRoot: string): string | undefined {
  const html = path.join(projectRoot, "index.html");
  let markup: string | undefined;
  try {
    markup = fs.readFileSync(html, "utf-8");
  } catch {
    markup = undefined;
  }
  if (markup) {
    MODULE_SCRIPT_TAG.lastIndex = 0;
    for (const tag of markup.match(MODULE_SCRIPT_TAG) ?? []) {
      if (!/\btype\s*=\s*["']module["']/i.test(tag)) continue;
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
      if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src)) continue;
      const resolved = src.startsWith("/")
        ? path.join(projectRoot, src)
        : path.resolve(path.dirname(html), src);
      if (isFile(resolved)) return resolved;
    }
  }
  for (const stem of NEXT_ENTRY_STEMS) {
    for (const extension of ENTRY_EXTENSIONS) {
      const candidate = path.join(projectRoot, stem + extension);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
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
  return undefined;
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

// Last resort, and bounded: a repository is big and this runs before anything is
// measured. Ties break on path so one project always yields one answer.
export function largestStylesheet(projectRoot: string): string | undefined {
  let best: { file: string; size: number } | undefined;
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
      if (!best || size > best.size || (size === best.size && full < best.file)) {
        best = { file: full, size };
      }
    }
  };

  walk(projectRoot, 0);
  return best?.file;
}

export interface CssDiscovery {
  files: string[];
  source: "entry" | "candidate" | "fallback" | "none";
}

// M71: evidence before convention. What the project's own entry imports is what
// the project loads; a filename list is a guess, and the largest stylesheet in
// the tree is a guess that says so.
export function discoverGlobalCss(projectRoot: string, warningsOut?: string[]): CssDiscovery {
  const workspaceRoot = findWorkspaceRoot(projectRoot);

  const entry = findProjectEntry(projectRoot);
  if (entry) {
    const imported = validateCssFiles(
      entryStylesheetImports(
        entry,
        projectRoot,
        loadTsconfigAliases(projectRoot),
        warningsOut,
        workspaceRoot,
      ),
      warningsOut,
    );
    if (imported.length > 0) return { files: imported, source: "entry" };
  }

  for (const candidate of GLOBAL_CSS_CANDIDATES) {
    const full = path.join(projectRoot, candidate);
    if (!isFile(full)) continue;
    if (preprocessorFor(full, projectRoot, workspaceRoot)) continue;
    return { files: [full], source: "candidate" };
  }

  const largest = largestStylesheet(projectRoot);
  if (largest && !preprocessorFor(largest, projectRoot, workspaceRoot)) {
    warningsOut?.push(CSS_FALLBACK_WARNING(path.relative(projectRoot, largest).replace(/\\/g, "/")));
    return { files: [largest], source: "fallback" };
  }

  return { files: [], source: "none" };
}

// Vite's root is projectRoot, so an in-root stylesheet uses the same
// root-absolute form as the component import. Anything else needs /@fs/.
export function cssImportSpecifier(cssFile: string, projectRoot: string): string {
  const relative = path.relative(projectRoot, cssFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return "/@fs/" + cssFile.replace(/\\/g, "/");
  }
  return "/" + relative.replace(/\\/g, "/");
}

export function cssImportBlock(specifiers?: string[]): string {
  if (!specifiers || specifiers.length === 0) return "";
  return specifiers.map((s) => `import "${s}";`).join("\n") + "\n";
}

export function detectTailwindVite(projectRoot: string): boolean {
  return isPackageAvailable("@tailwindcss/vite", projectRoot);
}

// Loaded from the project's own node_modules: the harness never carries a
// Tailwind version of its own. Import failure is non-fatal: PostCSS may still
// be configured, and a missing plugin must not abort a measurement run.
export async function loadTailwindVitePlugin(projectRoot: string): Promise<unknown[]> {
  try {
    const require = createRequire(path.join(projectRoot, "/"));
    const entry = require.resolve("@tailwindcss/vite");
    const mod = await import(pathToFileURL(entry).href);
    const factory = mod.default ?? mod;
    if (typeof factory !== "function") {
      throw new Error("@tailwindcss/vite has no callable default export");
    }
    const plugin = factory();
    return Array.isArray(plugin) ? plugin : [plugin];
  } catch (err) {
    process.stderr.write(
      `Warning: could not load @tailwindcss/vite from ${projectRoot}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return [];
  }
}

// M71: styling generated by a build step the harness does not run. Recognized
// so an unstyled-looking number is explainable; no plugin is ever loaded.
export const UNSUPPORTED_STYLE_ENGINES = [
  "unocss",
  "@unocss/vite",
  "@linaria/vite",
  "@linaria/core",
  "@pandacss/dev",
];

export function detectUnsupportedStyleEngines(
  projectRoot: string,
  workspaceRoot: string = findWorkspaceRoot(projectRoot),
): string[] {
  return UNSUPPORTED_STYLE_ENGINES.filter((pkg) =>
    isPackageAvailable(pkg, projectRoot, workspaceRoot),
  );
}

export function UNSUPPORTED_STYLE_ENGINE_WARNING(packages: string[]): string {
  return (
    `${packages.join(", ")} generates styles through a build step this harness does not run, so that ` +
    "styling is not replicated and the component may measure unstyled"
  );
}

// postcss-load-config's own search places, minus package.json.
const POSTCSS_CONFIG_FILES = [
  "postcss.config.ts",
  "postcss.config.cts",
  "postcss.config.mts",
  "postcss.config.js",
  "postcss.config.cjs",
  "postcss.config.mjs",
  ".postcssrc",
  ".postcssrc.json",
  ".postcssrc.yaml",
  ".postcssrc.yml",
  ".postcssrc.ts",
  ".postcssrc.cts",
  ".postcssrc.mts",
  ".postcssrc.js",
  ".postcssrc.cjs",
  ".postcssrc.mjs",
];

// Verified against the installed Vite 6.4.2: resolvePostcssConfig searches from
// its root up to searchForWorkspaceRoot(root) inclusive, and that helper knows
// only pnpm-workspace.yaml, lerna.json, and a package.json "workspaces" field.
// A repo whose root carries a lockfile alone stops Vite's walk at the member,
// so an inherited config is found here and passed in by hand. A member with its
// own config needs nothing: Vite's first level is already that directory.
export function findPostcssConfigAbove(
  memberRoot: string,
  workspaceRoot: string = findWorkspaceRoot(memberRoot),
): string | undefined {
  const hasConfig = (dir: string): boolean =>
    POSTCSS_CONFIG_FILES.some((name) => isFile(path.join(dir, name)));
  if (hasConfig(memberRoot)) return undefined;
  for (const level of workspaceLevels(memberRoot, workspaceRoot).slice(1)) {
    if (hasConfig(level)) return level;
  }
  return undefined;
}

export interface StyleTooling {
  tailwind: boolean;
  unsupportedEngines: string[];
  postcssConfigDir?: string;
  warnings: string[];
}

// M71: the Tailwind plugin generates utility CSS for the classes the measured
// component uses. Whether a global stylesheet was also found says nothing about
// whether it is needed, so no stylesheet list reaches this decision.
export function resolveStyleTooling(
  projectRoot: string,
  workspaceRoot: string = findWorkspaceRoot(projectRoot),
): StyleTooling {
  const unsupportedEngines = detectUnsupportedStyleEngines(projectRoot, workspaceRoot);
  const postcssConfigDir = findPostcssConfigAbove(projectRoot, workspaceRoot);
  return {
    tailwind: detectTailwindVite(projectRoot),
    unsupportedEngines,
    warnings:
      unsupportedEngines.length > 0 ? [UNSUPPORTED_STYLE_ENGINE_WARNING(unsupportedEngines)] : [],
    ...(postcssConfigDir ? { postcssConfigDir } : {}),
  };
}

// Probe order decides which file answers; `.ts` first matches what a project
// with two configs lying around is actually built with.
const VITE_CONFIG_FILES = [
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.cts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
];

// Ordered so the warning reads the same however the config file was written.
const IGNORED_KEY_ORDER = [
  "a computed config object",
  "publicDir",
  "resolve.alias",
  "css.preprocessorOptions",
  "plugins",
];

export interface ViteConfigData {
  configFile?: string;
  publicDir?: string;
  aliases: Array<{ find: RegExp; replacement: string }>;
  ignoredKeys: string[];
}

export function VITE_CONFIG_IGNORED_WARNING(configFile: string, keys: string[]): string {
  const base =
    `${configFile} declares ${keys.join(", ")}, which the harness read but cannot honor: the project's ` +
    "Vite config is never executed";
  return keys.includes("css.preprocessorOptions")
    ? `${base}; preprocessor globals (additionalData) are not replicated, so Sass or Less variables ` +
        "injected there are missing"
    : base;
}

function literalPropertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  const name = property.name;
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function stringLiteralValue(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

// The exported config object, through the shapes a config file is written in.
// Nothing is called and nothing is imported: this is the text of a file the
// harness must never execute.
function findViteConfigObject(source: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  const unwrap = (node: ts.Expression | undefined, depth = 0): ts.ObjectLiteralExpression | undefined => {
    if (!node || depth > 4) return undefined;
    if (ts.isObjectLiteralExpression(node)) return node;
    if (ts.isParenthesizedExpression(node)) return unwrap(node.expression, depth + 1);
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      return unwrap(node.expression, depth + 1);
    }
    if (ts.isCallExpression(node)) return unwrap(node.arguments[0], depth + 1);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const body = node.body;
      if (ts.isBlock(body)) {
        for (const statement of body.statements) {
          if (ts.isReturnStatement(statement)) return unwrap(statement.expression, depth + 1);
        }
        return undefined;
      }
      return unwrap(body, depth + 1);
    }
    return undefined;
  };

  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      return unwrap(statement.expression);
    }
    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      statement.expression.left.getText(source).replace(/\s/g, "") === "module.exports"
    ) {
      return unwrap(statement.expression.right);
    }
  }
  return undefined;
}

// M71: the config is read as text and parsed as a source file. It is never
// imported, so its plugins never load into this Vite and the invariant holds.
export function readViteConfigData(projectRoot: string): ViteConfigData {
  const data: ViteConfigData = { aliases: [], ignoredKeys: [] };

  let configFile: string | undefined;
  for (const name of VITE_CONFIG_FILES) {
    const candidate = path.join(projectRoot, name);
    if (isFile(candidate)) {
      configFile = candidate;
      break;
    }
  }
  if (!configFile) return data;
  data.configFile = configFile;

  let text: string;
  try {
    text = fs.readFileSync(configFile, "utf-8");
  } catch {
    return data;
  }

  const source = ts.createSourceFile(configFile, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const config = findViteConfigObject(source);
  if (!config) {
    data.ignoredKeys.push("a computed config object");
    return data;
  }

  const configDir = path.dirname(configFile);
  const ignored = new Set<string>();

  for (const property of config.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = literalPropertyName(property);

    if (name === "publicDir") {
      const literal = stringLiteralValue(property.initializer);
      const resolved = literal === undefined ? undefined : path.resolve(configDir, literal);
      if (resolved && isDirectory(resolved)) data.publicDir = resolved;
      else ignored.add("publicDir");
      continue;
    }

    if (name === "resolve" && ts.isObjectLiteralExpression(property.initializer)) {
      for (const inner of property.initializer.properties) {
        if (!ts.isPropertyAssignment(inner) || literalPropertyName(inner) !== "alias") continue;
        if (!ts.isObjectLiteralExpression(inner.initializer)) {
          ignored.add("resolve.alias");
          continue;
        }
        for (const entry of inner.initializer.properties) {
          const find = ts.isPropertyAssignment(entry) ? literalPropertyName(entry) : undefined;
          const target = ts.isPropertyAssignment(entry)
            ? stringLiteralValue(entry.initializer)
            : undefined;
          if (!find || target === undefined) {
            ignored.add("resolve.alias");
            continue;
          }
          const replacement = path.resolve(configDir, target);
          if (!fs.existsSync(replacement)) {
            ignored.add("resolve.alias");
            continue;
          }
          data.aliases.push({
            // Vite's object form matches a whole leading segment, the rule
            // @rollup/plugin-alias applies to a string `find`.
            find: new RegExp(`^${escapeRegex(find)}(?=/|$)`),
            replacement: replacement.replace(/\\/g, "/"),
          });
        }
      }
      continue;
    }

    if (name === "css" && ts.isObjectLiteralExpression(property.initializer)) {
      const hasPreprocessor = property.initializer.properties.some(
        (inner) => literalPropertyName(inner) === "preprocessorOptions",
      );
      if (hasPreprocessor) ignored.add("css.preprocessorOptions");
      continue;
    }

    if (name === "plugins") {
      const empty =
        ts.isArrayLiteralExpression(property.initializer) &&
        property.initializer.elements.length === 0;
      if (!empty) ignored.add("plugins");
    }
  }

  data.ignoredKeys = IGNORED_KEY_ORDER.filter((key) => ignored.has(key));
  return data;
}

export const ENV_DEFINE_PREFIXES = ["NEXT_PUBLIC_", "VITE_"];
const ENV_FILES = [".env", ".env.local"];
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// KEY=VALUE only: no interpolation, no export semantics, no dotenv dependency.
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = assignment.indexOf("=");
    if (separator <= 0) continue;
    const key = assignment.slice(0, separator).trim();
    if (!ENV_KEY_PATTERN.test(key)) continue;
    let value = assignment.slice(separator + 1).trim();
    const quote = value.charAt(0);
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

// Verified against the installed Vite 6.4.2: the vite:define transform returns
// early for a client environment outside a build, so config defines reach the
// page through vite/dist/client/env.mjs, which walks each dotted key and assigns
// it onto globalThis. Without one, `process` is undefined in the page and any
// `process.env.X` throws. Keys are sorted before serialization, so the bare
// object is created first and the specific keys are written into it.
// Only public prefixes are exported: a .env also holds database URLs.
export function readEnvDefines(
  memberRoot: string,
  workspaceRoot: string = findWorkspaceRoot(memberRoot),
): Record<string, string> {
  const levels =
    path.resolve(workspaceRoot) === path.resolve(memberRoot)
      ? [memberRoot]
      : [workspaceRoot, memberRoot];

  const values: Record<string, string> = {};
  for (const level of levels) {
    for (const name of ENV_FILES) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(level, name), "utf-8");
      } catch {
        continue;
      }
      Object.assign(values, parseEnvFile(text));
    }
  }

  const defines: Record<string, string> = { "process.env": "{}" };
  for (const [key, value] of Object.entries(values)) {
    if (!ENV_DEFINE_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    defines[`process.env.${key}`] = JSON.stringify(value);
  }
  return defines;
}

export const REACT_COMPILER_PACKAGE = "babel-plugin-react-compiler";

export const REACT_COMPILER_DISABLED_WARNING =
  "React Compiler is installed but disabled for this run; rerender costs will be higher than production.";

export function reactCompilerResolutionWarning(projectRoot: string): string {
  return (
    `${REACT_COMPILER_PACKAGE} is declared but could not be resolved from ${projectRoot}; ` +
    `measuring without the compiler transform.`
  );
}

// Package presence is the whole signal: next.config.* can be TypeScript and can
// compute its own config, which is a large evaluation surface for one boolean.
// Declared, never merely resolvable: the compiler rewrites the code that gets
// measured, so a hoisted transitive copy must not switch it on (M27 H14). The
// workspace root counts as a declaration; a hoisted install does not.
export function detectReactCompiler(projectRoot: string): boolean {
  return isPackageDeclared(REACT_COMPILER_PACKAGE, projectRoot);
}

// Walking up from the resolved entry reaches the package's own manifest in any
// layout; the package.json subpath does not, because an exports map may hide it.
function readCompilerVersion(pluginPath: string): string | undefined {
  let dir = path.dirname(pluginPath);
  while (true) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(manifest, "utf-8"));
        if (pkg?.name !== REACT_COMPILER_PACKAGE) return undefined;
        return typeof pkg.version === "string" ? pkg.version : undefined;
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface ReactCompilerResolution {
  pluginPath?: string;
  version?: string;
}

// Resolved from the project so the compiler version matches what it ships.
export function resolveReactCompiler(projectRoot: string): ReactCompilerResolution {
  try {
    const projectRequire = createRequire(path.join(projectRoot, "/"));
    const pluginPath = projectRequire.resolve(REACT_COMPILER_PACKAGE);
    const version = readCompilerVersion(pluginPath);
    return { pluginPath, ...(version ? { version } : {}) };
  } catch {
    return {};
  }
}

export interface ReactCompilerState {
  detected: boolean;
  active: boolean;
  version?: string;
  pluginPath?: string;
  warning?: string;
}

// At most one warning per state, so the disabled note and the resolution note
// can never both reach the report.
export function resolveReactCompilerState(
  projectRoot: string,
  requested: boolean | undefined,
): ReactCompilerState {
  const detected = detectReactCompiler(projectRoot);

  if (requested === false) {
    return {
      detected,
      active: false,
      ...(detected ? { warning: REACT_COMPILER_DISABLED_WARNING } : {}),
    };
  }
  if (requested === undefined && !detected) return { detected: false, active: false };

  const { pluginPath, version } = resolveReactCompiler(projectRoot);
  if (!pluginPath) {
    if (requested === true) {
      throw new Error(
        `${REACT_COMPILER_PACKAGE} not found in ${projectRoot}; install ${REACT_COMPILER_PACKAGE} ` +
          `in the project, or drop --react-compiler.`,
      );
    }
    return {
      detected,
      active: false,
      warning: reactCompilerResolutionWarning(projectRoot),
    };
  }
  return { detected, active: true, pluginPath, ...(version ? { version } : {}) };
}

// Compiled output imports react/compiler-runtime. @vitejs/plugin-react only
// pre-bundles that module when it recognises the babel plugin by its bare name,
// and K2 requires the project-resolved absolute path, so the import has to be
// declared here: otherwise Vite discovers it on the first page load and forces
// a full reload that destroys the execution context mid-measurement. React 18
// projects have no such module; there the entry is skipped.
export function reactCompilerRuntimeDeps(projectRoot: string): string[] {
  try {
    createRequire(path.join(projectRoot, "/")).resolve("react/compiler-runtime");
    return ["react/compiler-runtime"];
  } catch {
    return [];
  }
}

// Vite transforms the generated .tsx entry with the automatic JSX runtime, so
// the page imports react/jsx-dev-runtime even though nothing declares it. Left
// undeclared, Vite discovers it on the first page load of a project whose
// optimizer cache is cold, pre-bundles it, and full-reloads: destroying the
// execution context mid-measurement. Resolved from the project: React 16 has no
// automatic runtime, and an unresolvable include aborts server start.
export function reactJsxRuntimeDeps(projectRoot: string): string[] {
  const projectRequire = createRequire(path.join(projectRoot, "/"));
  const deps: string[] = [];
  for (const dep of ["react/jsx-runtime", "react/jsx-dev-runtime"]) {
    try {
      projectRequire.resolve(dep);
      deps.push(dep);
    } catch {
      // Not available in this React version.
    }
  }
  return deps;
}

// Imported on demand: a run without the compiler never loads @babel/core.
export async function loadReactCompilerPlugin(pluginPath: string): Promise<unknown[]> {
  const mod = await import("@vitejs/plugin-react");
  const factory = (mod as { default?: unknown }).default ?? mod;
  if (typeof factory !== "function") {
    throw new Error("@vitejs/plugin-react has no callable default export");
  }
  const plugin = (factory as (options: unknown) => unknown)({
    babel: { plugins: [[pluginPath, {}]] },
  });
  return Array.isArray(plugin) ? plugin : [plugin];
}

// M48. A curated passthrough, not `vite.config` wholesale: each entry is an
// explicit integration resolved from the *project's* node_modules, following
// the M27 React Compiler pattern.
//
// The support list is evidence-driven. `probeCandidates` are the ones the M48
// spike verified end to end against a real project; anything else stays a
// recognizer-only diagnosis until a spike proves it loads.
export interface TransformPlugin {
  // Matches a `TRANSFORM_RECOGNIZERS` code, so a diagnosis and a fix share a name.
  code: string;
  packageName: string;
  // The named export carrying the factory, for packages that have no default.
  exportName?: string;
  // Some plugins need options to behave outside their normal dev-server context.
  options?: unknown;
}

export const SUPPORTED_TRANSFORM_PLUGINS: TransformPlugin[] = [
  { code: "svgr", packageName: "vite-plugin-svgr" },
  {
    code: "vanilla-extract",
    packageName: "@vanilla-extract/vite-plugin",
    exportName: "vanillaExtractPlugin",
  },
  // M57. Without it nothing mounts a `.vue` file at all, so this is the one
  // entry on the list a whole framework depends on. A project with `.vue` files
  // and no plugin keeps the M48 recognizer warning.
  { code: "vue", packageName: "@vitejs/plugin-vue" },
];

// Three shapes in the wild, all seen in the M48 spike: a real default export, a
// CJS package double-wrapped by interop (`mod.default.default`), and a package
// whose factory is only a named export.
export function resolvePluginFactory(
  mod: unknown,
  exportName?: string,
): ((options?: unknown) => unknown) | undefined {
  const namespace = mod as Record<string, unknown>;
  const candidates: unknown[] = [];
  if (exportName) candidates.push(namespace?.[exportName]);
  candidates.push(namespace?.default);
  const asDefault = namespace?.default as Record<string, unknown> | undefined;
  candidates.push(asDefault?.default);
  if (exportName) candidates.push(asDefault?.[exportName]);
  candidates.push(mod);
  return candidates.find((c) => typeof c === "function") as
    | ((options?: unknown) => unknown)
    | undefined;
}

export function detectProjectTransforms(projectRoot: string): TransformPlugin[] {
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  return SUPPORTED_TRANSFORM_PLUGINS.filter((entry) =>
    isPackageAvailable(entry.packageName, projectRoot, workspaceRoot),
  );
}

// Server and HMR hooks are stripped: the harness owns the server's lifecycle,
// and a project plugin reaching into it is the class of failure M30 documented.
// Build-time hooks: resolve/load/transform: are the whole point.
const STRIPPED_PLUGIN_HOOKS = [
  "configureServer",
  "configurePreviewServer",
  "handleHotUpdate",
  "hotUpdate",
];

export function stripServerHooks(plugin: unknown): unknown {
  if (!plugin || typeof plugin !== "object") return plugin;
  const copy: Record<string, unknown> = { ...(plugin as Record<string, unknown>) };
  for (const hook of STRIPPED_PLUGIN_HOOKS) delete copy[hook];
  return copy;
}

export const TRANSFORM_LOAD_FAILED_WARNING = (code: string, detail: string): string =>
  `[transform:${code}] the project's plugin could not be loaded, so imports it owns will not ` +
  `compile: ${detail}. The run continues without it.`;

export async function loadProjectTransformPlugins(
  projectRoot: string,
  entries: TransformPlugin[],
  onWarning?: (warning: string) => void,
): Promise<unknown[]> {
  const loaded: unknown[] = [];
  for (const entry of entries) {
    try {
      const projectRequire = createRequire(path.join(projectRoot, "/"));
      const resolved = projectRequire.resolve(entry.packageName);
      const mod = await import(pathToFileURL(resolved).href);
      const factory = resolvePluginFactory(mod, entry.exportName);
      if (!factory) {
        throw new Error(`${entry.packageName} exposes no callable plugin factory`);
      }
      const produced = factory(entry.options);
      const list = Array.isArray(produced) ? produced : [produced];
      loaded.push(...list.map(stripServerHooks));
    } catch (err) {
      // Never fatal: a component that does not touch this transform still
      // measures, and one that does gets M48's recognizer diagnosis anyway.
      onWarning?.(TRANSFORM_LOAD_FAILED_WARNING(entry.code, err instanceof Error ? err.message : String(err)));
    }
  }
  return loaded;
}

// Probe order is significant: first hit wins (W1).
export const WRAPPER_CANDIDATES = [
  "120fps.setup.tsx",
  "120fps.setup.jsx",
  "120fps.setup.ts",
  "120fps.setup.js",
  "120fps.setup.vue",
];

// A `.tsx` wrapper in a Vue project cannot render a Vue component, so the SFC
// is probed first there: otherwise a stray leftover file would silently break
// the run it was supposed to fix.
export function detectWrapper(projectRoot: string, framework?: string): string | undefined {
  const candidates =
    framework === "vue"
      ? ["120fps.setup.vue", ...WRAPPER_CANDIDATES.filter((c) => c !== "120fps.setup.vue")]
      : WRAPPER_CANDIDATES;
  for (const name of candidates) {
    const candidate = path.join(projectRoot, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // missing or unreadable: try the next candidate
    }
  }
  return undefined;
}

// Static approximation of "default export is a React component": we can only
// rule out the cases that are provably not callable. The wrapper may import
// CSS and browser-only packages, so it cannot be evaluated in Node.
function hasCallableDefaultExport(sourceText: string, fileName: string): boolean {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, false);
  let found = false;

  ts.forEachChild(sourceFile, (node) => {
    if (found) return;

    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const expr = node.expression;
      const notCallable =
        ts.isObjectLiteralExpression(expr) ||
        ts.isArrayLiteralExpression(expr) ||
        ts.isNumericLiteral(expr) ||
        ts.isStringLiteral(expr) ||
        ts.isNoSubstitutionTemplateLiteral(expr) ||
        expr.kind === ts.SyntaxKind.TrueKeyword ||
        expr.kind === ts.SyntaxKind.FalseKeyword ||
        expr.kind === ts.SyntaxKind.NullKeyword;
      if (!notCallable) found = true;
      return;
    }

    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      found = true;
      return;
    }

    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const spec of node.exportClause.elements) {
        if (!spec.isTypeOnly && spec.name.text === "default") found = true;
      }
    }
  });

  return found;
}

// @vitejs/plugin-vue emits `import _sfc_main from "<sfc>?vue&type=script"`
// whenever an SFC has any <script> block, so a block that produces no default
// export fails module evaluation in the browser: the Vue analogue of the
// missing-default-export wrapper M26 fixed for React. An SFC with no <script>
// at all is fine: the plugin synthesizes an empty component for it.
//
// An empty `<script setup>` counts as absent to the compiler, which is the
// shape that looks most correct and fails hardest.
export function sfcProducesComponent(
  source: string,
  fileName: string,
  compiler: VueSfcCompiler,
): boolean {
  let descriptor;
  try {
    descriptor = compiler.parse(source, { filename: fileName }).descriptor;
  } catch {
    // A malformed SFC is the plugin's error to report, with real positions.
    return true;
  }
  const setup = descriptor?.scriptSetup;
  const script = descriptor?.script;
  if (!setup && !script) return true;
  if (setup && setup.content.trim().length > 0) return true;
  if (script && hasAnyDefaultExport(script.content, `${fileName}.ts`)) return true;
  return false;
}

// Vue's Options API default-exports a plain object, which
// `hasCallableDefaultExport` deliberately rejects for React. Here the question
// is only whether the module has a default export at all: the plugin imports
// it either way, and an object is a perfectly good Vue component.
function hasAnyDefaultExport(sourceText: string, fileName: string): boolean {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, false);
  let found = false;

  ts.forEachChild(sourceFile, (node) => {
    if (found) return;
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      found = true;
      return;
    }
    if (
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      found = true;
      return;
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const spec of node.exportClause.elements) {
        if (!spec.isTypeOnly && spec.name.text === "default") found = true;
      }
    }
  });

  return found;
}

export const SFC_NO_COMPONENT = (relative: string): string =>
  `${relative} has a <script> block that exports no component, so nothing can be mounted from it. ` +
  "Add `export default` to that block, or move the code into a non-empty <script setup> " +
  "(an empty <script setup> counts as absent to the Vue compiler).";

export function resolveWrapper(wrapPath: string, projectRoot: string): string {
  const absolute = path.resolve(wrapPath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Wrapper module not found: ${wrapPath}`);
  }
  const relative = path.relative(projectRoot, absolute).replace(/\\/g, "/");
  // M73: the raw relative path decides, not its forward-slashed form: a wrapper
  // on another Windows drive has an absolute relative form and no "../" prefix.
  if (isOutsideRoot(absolute, projectRoot)) {
    throw new Error(
      `Wrapper module ${wrapPath} must live inside the project root ${projectRoot}`,
    );
  }
  const source = fs.readFileSync(absolute, "utf-8");
  if (isVueFile(absolute)) {
    // An SFC's component is its default export by construction; the only thing
    // provable here is that the file is an SFC at all.
    if (!/<template[\s>]|<script[\s>]/.test(source)) {
      throw new Error(
        `Wrapper module ${wrapPath} must be a Vue single-file component rendering its default slot`,
      );
    }
    return relative;
  }
  if (!hasCallableDefaultExport(source, absolute)) {
    throw new Error(
      `Wrapper module ${wrapPath} must default-export a React component taking { children }`,
    );
  }
  return relative;
}

export async function buildAndServe(
  componentPath: string,
  options?: BuildHarnessOptions,
): Promise<HarnessResult> {
  const absoluteComponentPath = path.resolve(componentPath);
  if (!fs.existsSync(absoluteComponentPath)) {
    throw new Error(`Component file not found: ${componentPath}`);
  }

  const componentDir = path.dirname(absoluteComponentPath);
  const projectRoot = findProjectRoot(componentDir) ?? componentDir;

  // Validate before creating the harness dir so a rejected wrapper or an
  // unresolvable forced compiler leaves nothing behind
  const wrapRelative = options?.wrapPath
    ? resolveWrapper(options.wrapPath, projectRoot)
    : undefined;
  const reactCompiler = resolveReactCompilerState(projectRoot, options?.reactCompiler);
  // Only the resolution failure is a surprise worth printing; the disabled note
  // is a consequence of the user's own flag and travels in the report.
  if (options?.reactCompiler !== false && reactCompiler.warning) {
    process.stderr.write(`Warning: ${reactCompiler.warning}\n`);
  }

  // M57: an SFC that compiles to no component would otherwise surface as a 30s
  // readiness timeout with a module-resolution message attached, naming the
  // harness instead of the file to fix. Checked here so nothing is left behind.
  const renderer = rendererFor(absoluteComponentPath);
  if (renderer === "vue") {
    const compiler = await loadVueCompiler(projectRoot);
    if (compiler) {
      const sfcs = [
        absoluteComponentPath,
        ...(options?.wrapPath ? [path.resolve(options.wrapPath)] : []),
      ];
      for (const sfc of sfcs) {
        if (!isVueFile(sfc)) continue;
        if (!sfcProducesComponent(fs.readFileSync(sfc, "utf-8"), sfc, compiler)) {
          throw new Error(SFC_NO_COMPONENT(path.relative(projectRoot, sfc).replace(/\\/g, "/")));
        }
      }
    }
  }

  // M73: react-dom/client is forced into optimizeDeps.include below, and an
  // unresolvable include aborts Vite's optimizer with an esbuild path dump.
  if (renderer === "react") assertReactDomClient(projectRoot);

  // Crash leftovers from previous runs: best-effort removal (M24 D8)
  sweepStaleHarnessDirs(projectRoot);

  // Place harness files inside the target project so Vite resolves aliases
  const harnessDir = createHarnessDir(projectRoot);
  const harnessDirName = path.basename(harnessDir);

  const componentRelative = componentImportPath(absoluteComponentPath, projectRoot);

  const cssFiles = [...new Set((options?.cssFiles ?? []).map((f) => path.resolve(f)))];
  const cssImports = cssFiles.map((f) => cssImportSpecifier(f, projectRoot));

  const presetRelative = options?.presetPath
    ? path.relative(projectRoot, path.resolve(options.presetPath)).replace(/\\/g, "/")
    : undefined;

  let entryTsx: string;
  let component: ComponentIdentity;

  if (options?.composition) {
    entryTsx = generateComposedEntry(
      componentRelative,
      options.composition,
      options.exports,
      wrapRelative,
      cssImports,
    );
    const root = options.composition.root;
    component = {
      relative: componentRelative,
      name: root,
      isDefaultExport: options.exports?.some((e) => e.name === root && e.isDefault) ?? false,
    };
  } else {
    const { name: componentName, isDefaultOnly } = detectComponentExport(
      absoluteComponentPath,
      options?.target,
    );
    component = {
      relative: componentRelative,
      name: componentName,
      isDefaultExport: isDefaultOnly,
    };
    entryTsx = generateEntry({
      componentRelative,
      componentName,
      isDefaultExport: isDefaultOnly,
      hasScale: detectScaleExport(absoluteComponentPath),
      wrapRelative,
      cssImports,
      renderer,
      ...(presetRelative ? { presetRelative } : {}),
    });
  }

  // The Vue entry has no JSX, so it is a .ts file: and index.html has to name
  // whichever one was written.
  const entryFile = renderer === "vue" ? "entry.ts" : "entry.tsx";
  const indexHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>120fps harness</title></head>
<body><div id="root"></div><script type="module" src="./${entryFile}"></script></body>
</html>`;

  fs.writeFileSync(path.join(harnessDir, entryFile), entryTsx);
  fs.writeFileSync(path.join(harnessDir, "index.html"), indexHtml);

  // M69: alias construction and the scan both report what they could not
  // resolve, and both feed the same run warnings.
  const configWarnings: string[] = [];
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  const tsconfigAliases = loadTsconfigAliases(projectRoot, configWarnings);
  const hasNextJs = !options?.noShims && detectNextJs(projectRoot);
  const shimAliases = buildShimAliases(hasNextJs);
  // M71: what the project's own vite.config says, read as text. Its aliases sit
  // below the tsconfig paths, which is the precedence a TypeScript project
  // already assumes, and above the shims, which answer for one module each.
  const viteConfig = readViteConfigData(projectRoot);
  if (viteConfig.configFile && viteConfig.ignoredKeys.length > 0) {
    configWarnings.push(
      VITE_CONFIG_IGNORED_WARNING(path.basename(viteConfig.configFile), viteConfig.ignoredKeys),
    );
  }
  const alias: Array<{ find: RegExp; replacement: string; isShim?: boolean }> = [
    ...tsconfigAliases,
    ...viteConfig.aliases,
    ...shimAliases,
  ];

  // The wrapper is imported by the entry, so its packages must be pre-bundled
  // too: otherwise the first mount pays Vite's on-demand optimize cost.
  const importedSpecifiers = new Set<string>();
  const externalDeps = [
    ...new Set([
      ...scanExternalDeps(
        absoluteComponentPath,
        projectRoot,
        alias,
        importedSpecifiers,
        configWarnings,
      ),
      ...(options?.wrapPath
        ? scanExternalDeps(
            path.resolve(options.wrapPath),
            projectRoot,
            alias,
            importedSpecifiers,
            configWarnings,
          )
        : []),
    ]),
  ];

  // Shims are keyed by module specifier ("next/image"), which scanExternalDeps
  // collapses to a package name ("next") for optimizeDeps: match on the raw
  // specifiers instead.
  let activeShims: string[] | undefined;
  if (hasNextJs) {
    const shimmed = SHIM_MODULES.filter((s) => importedSpecifiers.has(s.module)).map(
      (s) => s.module,
    );
    activeShims = shimmed.length > 0 ? shimmed : undefined;
    const unshimmed = unshimmedNextModules(importedSpecifiers);
    if (unshimmed.length > 0) configWarnings.push(UNSUPPORTED_NEXT_MODULE_WARNING(unshimmed));
  }

  // A Vue project has no react to pre-bundle, and an unresolvable include
  // aborts server start: so the renderer decides the base list, not a union.
  const rendererDeps =
    renderer === "vue"
      ? ["vue"]
      : [
          "react",
          "react-dom/client",
          ...reactJsxRuntimeDeps(projectRoot),
          ...(reactCompiler.active ? reactCompilerRuntimeDeps(projectRoot) : []),
        ];

  const stableInclude = unionCachedDeps(
    [...rendererDeps, ...externalDeps],
    readDepCacheMetadata(projectRoot),
  );

  // M71: the Tailwind plugin is decided by the project's dependency alone. A
  // component using utility classes needs it whether or not a global stylesheet
  // was found, and the styling engines nothing here can replicate say so once.
  const styleTooling = resolveStyleTooling(projectRoot, workspaceRoot);
  configWarnings.push(...styleTooling.warnings);
  const plugins: unknown[] = styleTooling.tailwind
    ? await loadTailwindVitePlugin(projectRoot)
    : [];
  // Appended, never substituted: the Tailwind entries above must survive.
  if (reactCompiler.active) {
    plugins.push(...(await loadReactCompilerPlugin(reactCompiler.pluginPath!)));
  }

  // M48: the project's own transforms, resolved from its own node_modules with
  // server hooks stripped. Load failure warns and continues.
  const transformWarnings: string[] = [];
  const transformEntries = options?.noTransforms ? [] : detectProjectTransforms(projectRoot);
  if (transformEntries.length > 0) {
    plugins.push(
      ...(await loadProjectTransformPlugins(projectRoot, transformEntries, (warning) =>
        transformWarnings.push(warning),
      )),
    );
  }

  // M69: Vite refuses to serve a file outside its allow list. Undefined for a
  // project whose alias targets are all inside its own root, which keeps
  // Vite's defaults everywhere they already worked.
  // Vite's own default is the one root it searches for; widening never narrows
  // it, so its answer joins the list whenever the list exists at all.
  // M73: Vite serves nothing outside its allow list, so a component reached
  // through /@fs/ needs its own directory named.
  const aliasAllow = fsAllowDirs(
    projectRoot,
    workspaceRoot,
    alias,
    componentRelative.startsWith("@fs/") ? [componentDir] : [],
  );
  const fsAllow = aliasAllow && [...new Set([...aliasAllow, searchForWorkspaceRoot(projectRoot)])];

  // M71: without these the page has no `process` at all, and a component
  // reading process.env throws before it renders.
  const define = readEnvDefines(projectRoot, workspaceRoot);

  const bootServer = async (): Promise<ViteDevServer> => {
    const created = await createServer({
      root: projectRoot,
      // The project's vite.config is not ours to run: its plugins target the
      // project's own Vite major (a rolldown plugin-react in a Vite 6 container
      // fails every transform), and its server options are not measurement-safe.
      // Aliases and the plugins we do need are reconstructed above by hand.
      configFile: false,
      logLevel: "silent",
      plugins: plugins as never,
      define,
      // The project's own static directory, recovered from the config text: its
      // fonts 404 otherwise and every text metric becomes a fallback-font one.
      ...(viteConfig.publicDir ? { publicDir: viteConfig.publicDir } : {}),
      // Vite searches from its root up to its own idea of the workspace root,
      // which a lockfile-only monorepo root does not satisfy; naming the
      // directory is a no-op wherever its own walk already reaches.
      ...(styleTooling.postcssConfigDir
        ? { css: { postcss: styleTooling.postcssConfigDir } }
        : {}),
      server: {
        port: 0,
        strictPort: false,
        // With the overlay on, Vite renders transform failures into a DOM element
        // and logs nothing; with it off the client console.errors the full
        // message, which the page-error capture turns into a usable diagnosis.
        hmr: { overlay: false },
        // M34: nothing edits files during a measurement run, so file watching is
        // pure cost: chokidar's initial scan of a real repo (a Next.js .next/
        // dir has thousands of files) saturates the fs threadpool exactly when
        // the first module loads, and a watcher-triggered reload mid-measurement
        // is the failure M30's context retry exists for.
        watch: null,
        ...(fsAllow ? { fs: { allow: fsAllow } } : {}),
      },
      resolve: {
        alias,
        dedupe: renderer === "vue" ? ["vue"] : ["react", "react-dom"],
      },
      optimizeDeps: {
        include: stableInclude,
      },
    });
    await created.listen();
    return created;
  };

  let server: ViteDevServer;
  let ownsServer = true;
  const buildWarnings: string[] = [...transformWarnings, ...new Set(configWarnings)];
  try {
    if (options?.serverPool) {
      // The tuple that shapes a server; anything else is per-component and
      // lives in the harness dir, not the server.
      const poolKey = JSON.stringify([
        projectRoot,
        [...cssFiles].sort(),
        options?.wrapPath ? path.resolve(options.wrapPath) : null,
        reactCompiler.active,
        options?.noShims ?? false,
      ]);
      const acquired = await options.serverPool.acquire(poolKey, bootServer, stableInclude);
      server = acquired.server;
      ownsServer = false;
      if (acquired.reused) {
        const missing = stableInclude.filter((dep) => !acquired.include.has(dep));
        if (missing.length > 0) buildWarnings.push(SWEEP_DEP_WARNING(missing));
      }
    } else {
      server = await bootServer();
    }
  } catch (err) {
    throw new Error(
      VITE_START_FAILED(harnessDir, err instanceof Error ? err.message : String(err)),
      { cause: err },
    );
  }

  const address = server.httpServer?.address();
  let url: string;
  if (address && typeof address === "object") {
    url = `http://localhost:${address.port}/${harnessDirName}/`;
  } else {
    throw new Error(VITE_START_FAILED(harnessDir, "no listening address was returned"));
  }

  const cleanup = async () => {
    if (ownsServer) await server.close();
    fs.rmSync(harnessDir, { recursive: true, force: true });
  };

  return {
    url,
    server,
    componentPath: absoluteComponentPath,
    harnessDir,
    cleanup,
    component,
    nextJsShims: activeShims,
    reactCompiler,
    ...(wrapRelative !== undefined
      ? { wrapPath: path.resolve(options!.wrapPath!), wrapRelative }
      : {}),
    ...(cssFiles.length > 0 ? { cssFiles } : {}),
    ...(buildWarnings.length > 0 ? { warnings: buildWarnings } : {}),
  };
}

// M34: any change to optimizeDeps.include changes Vite's config hash, and a
// changed hash forces a full dependency re-bundle (~10s) on the next run. The
// scanned list varies per component, so every component of a sweep paid it.
// Union the list with whatever the project's dep cache already optimized: the
// list converges to a stable superset and repeat runs hit the cache. A missing
// or corrupt cache costs one re-bundle, nothing else.
export function unionCachedDeps(
  include: string[],
  metadataJson: string | undefined,
): string[] {
  let cached: string[] = [];
  if (metadataJson) {
    try {
      const parsed = JSON.parse(metadataJson) as { optimized?: Record<string, unknown> };
      cached = Object.keys(parsed.optimized ?? {});
    } catch {
      // Not ours to repair; Vite rewrites it on the next optimize pass.
    }
  }
  return [...new Set([...include, ...cached])].sort();
}

function readDepCacheMetadata(projectRoot: string): string | undefined {
  try {
    return fs.readFileSync(
      path.join(projectRoot, "node_modules", ".vite", "deps", "_metadata.json"),
      "utf8",
    );
  } catch {
    return undefined;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STALE_HARNESS_MAX_AGE_MS = 60 * 60 * 1000;

// Best-effort removal of .120fps-harness-* leftovers older than 1 hour (M24 D8).
export function sweepStaleHarnessDirs(projectRoot: string): void {
  try {
    const cutoff = Date.now() - STALE_HARNESS_MAX_AGE_MS;
    for (const entry of fs.readdirSync(projectRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(".120fps-harness-")) continue;
      const full = path.join(projectRoot, entry.name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.rmSync(full, { recursive: true, force: true });
        }
      } catch {
        // best-effort: dir may be in use or already gone
      }
    }
  } catch {
    // best-effort: unreadable project root
  }
}

const TMP_SWEEP_PREFIX = /^\.?120fps-/;
const TMP_SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Bounds worst-case sweep time against a pathologically large temp dir; any
// remainder is picked up on the next sweep.
export const TMP_SWEEP_MAX_REMOVALS = 500;

// M56: best-effort removal of this tool's own OS-tmp leftovers (e.g.
// `120fps-ctx-*`, `120fps-memo-*`) older than 24h. A directory belonging to a
// live run is by construction younger than the cutoff, so no lockfile is
// needed: prefix + location + age is a three-factor guard against deleting
// anything foreign. Takes baseDir as a parameter for testability; real runs
// use the OS temp dir.
export function sweepStaleTmpDirs(baseDir: string = os.tmpdir()): void {
  try {
    const cutoff = Date.now() - TMP_SWEEP_MAX_AGE_MS;
    let removed = 0;
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (removed >= TMP_SWEEP_MAX_REMOVALS) break;
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (!TMP_SWEEP_PREFIX.test(entry.name)) continue;
      const full = path.join(baseDir, entry.name);
      try {
        // lstat, not stat: never follow a symlink out of the temp dir.
        const stat = fs.lstatSync(full);
        if (!stat.isDirectory() || stat.mtimeMs >= cutoff) continue;
        fs.rmSync(full, { recursive: true, force: true });
        removed++;
      } catch {
        // best-effort: in use, permission-denied, or already gone
      }
    }
  } catch {
    // best-effort: unreadable or nonexistent temp dir
  }
}

// Files worth reading for further imports. A .json or an asset is a leaf.
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts", ".vue"];
const EXTENSIONS = [...SOURCE_EXTENSIONS, ".json"];

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

// M69: a directory import answers through its manifest before its index file,
// the way node and Vite resolve it.
function resolveDirectoryEntry(dir: string): string | undefined {
  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
  } catch {
    return undefined;
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return undefined;
  const fields = manifest as Record<string, unknown>;
  const candidates = [
    conditionalEntry(fields.exports),
    typeof fields.module === "string" ? fields.module : undefined,
    typeof fields.main === "string" ? fields.main : undefined,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = resolveFileWithExtension(path.resolve(dir, candidate));
    if (resolved) return resolved;
  }
  return undefined;
}

// The root export of an "exports" map, in the order a bundler reads it. Nested
// condition objects are followed one level, which covers { ".": { import: ... } }
// and { ".": { node: { import: ... } } }.
function conditionalEntry(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value) || depth > 2) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const root = depth === 0 && "." in record ? record["."] : record;
  if (typeof root === "string") return root;
  if (typeof root !== "object" || root === null) return undefined;
  for (const condition of ["import", "module", "browser", "default", "require"]) {
    const entry = (root as Record<string, unknown>)[condition];
    const resolved = conditionalEntry(entry, depth + 1);
    if (resolved) return resolved;
  }
  return undefined;
}

function resolveFileWithExtension(target: string): string | undefined {
  if (isFile(target)) return target;
  for (const ext of EXTENSIONS) {
    if (isFile(target + ext)) return target + ext;
  }
  return undefined;
}

function resolveTarget(target: string): string | undefined {
  const direct = resolveFileWithExtension(target);
  if (direct) return direct;
  const fromManifest = resolveDirectoryEntry(target);
  if (fromManifest) return fromManifest;
  for (const ext of EXTENSIONS) {
    const indexFile = path.join(target, "index" + ext);
    if (isFile(indexFile)) return indexFile;
  }
  return undefined;
}

// M62: the alias that resolved a bare specifier matters for shim-usage
// reporting, not just where it points: a shim alias redirects a real
// package specifier to a local file, and that specifier is still "imported"
// even though this function treats the result as local. Returning
// viaShimAlias lets the caller record it without this function knowing
// anything about SHIM_MODULES.
// M69: "no alias matched" and "an alias matched and its target is gone" are
// different facts. Collapsing them into null pushed a stale alias into
// optimizeDeps.include as if a package by that name existed.
type LocalResolution =
  | { kind: "resolved"; path: string; viaShimAlias: boolean }
  | { kind: "alias-miss"; target: string; viaShimAlias: boolean }
  | { kind: "unaliased" };

function resolveLocalImport(
  fromFile: string,
  spec: string,
  projectRoot: string,
  aliases: Array<{ find: RegExp; replacement: string; isShim?: boolean }>,
): LocalResolution {
  let target: string;
  let viaShimAlias = false;
  let aliased = false;
  if (spec.startsWith(".") || spec.startsWith("/")) {
    target = path.resolve(path.dirname(fromFile), spec);
  } else {
    let aliasedPath: string | undefined;
    for (const { find, replacement, isShim } of aliases) {
      if (find.test(spec)) {
        aliasedPath = spec.replace(find, replacement);
        viaShimAlias = isShim === true;
        break;
      }
    }
    if (aliasedPath === undefined) return { kind: "unaliased" };
    aliased = true;
    target = path.isAbsolute(aliasedPath) ? aliasedPath : path.resolve(projectRoot, aliasedPath);
  }

  const resolved = resolveTarget(target);
  if (resolved) return { kind: "resolved", path: resolved, viaShimAlias };
  if (!aliased) return { kind: "unaliased" };
  return { kind: "alias-miss", target: target.replace(/\\/g, "/"), viaShimAlias };
}

// Static imports and re-exports, dynamic import(), and require(). String
// literals only: a template literal or a computed specifier is unknowable
// without running the code.
const STATIC_IMPORT_PATTERN =
  /(?:^|\s)(?:import|export)\s.*?from\s+["']([^"']+)["']|(?:^|\s)import\s+["']([^"']+)["']/gm;
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

export function BROKEN_ALIAS_WARNING(specifier: string, target: string): string {
  return (
    `import "${specifier}" matches a configured path alias, but its target ${target} does not exist; ` +
    "the alias is stale or the file was moved, and the import will not resolve in the harness"
  );
}

export function scanExternalDeps(
  componentPath: string,
  projectRoot: string,
  aliases: Array<{ find: RegExp; replacement: string; isShim?: boolean }>,
  specifiersOut?: Set<string>,
  warningsOut?: string[],
): string[] {
  const externalPkgs = new Set<string>();
  const visited = new Set<string>();
  const reportedBrokenAliases = new Set<string>();
  const queue = [componentPath];

  while (queue.length > 0) {
    const file = queue.shift()!;
    const normalizedFile = path.resolve(file);
    if (visited.has(normalizedFile)) continue;
    visited.add(normalizedFile);

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
      } else if (isBareSpecifier) {
        specifiersOut?.add(spec);
        const pkg = spec.startsWith("@")
          ? spec.split("/").slice(0, 2).join("/")
          : spec.split("/")[0];
        externalPkgs.add(pkg);
      }
    }
  }

  externalPkgs.delete("react");
  externalPkgs.delete("react-dom");

  const BLOCKED = new Set([
    "next", "webpack", "critters", "fibers",
    "react-server-dom-webpack", "react-server-dom-turbopack",
    "@vercel/turbopack-ecmascript-runtime",
    "@next/env", "@next/swc-linux-x64-gnu", "@next/swc-linux-x64-musl",
    "@next/swc-darwin-arm64", "@next/swc-darwin-x64",
    "@next/swc-win32-x64-msvc", "@next/swc-win32-arm64-msvc",
    "sass", "less", "stylus", "lightningcss", "sugarss",
  ]);

  for (const pkg of externalPkgs) {
    if (BLOCKED.has(pkg) || pkg.startsWith("@next/") || pkg.startsWith("@vercel/turbopack")) {
      externalPkgs.delete(pkg);
    }
  }

  return [...externalPkgs];
}

// M69: an entry whose two halves disagree about the wildcard produced a regex
// that could never match, so the alias was absent and nothing said so.
export function ALIAS_SHAPE_WARNING(pattern: string, target: string): string {
  return (
    `tsconfig path alias "${pattern}" -> "${target}": one side has a "*" and the other does not, ` +
    "so no alias was built and imports matching that pattern will not resolve"
  );
}

// M69: the CRA shape. With baseUrl set and no paths, a bare specifier resolves
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
      replacement: path.resolve(baseUrl, entry.name).replace(/\\/g, "/"),
    });
  }
  return aliases;
}

export function loadTsconfigAliases(
  projectRoot: string,
  warningsOut?: string[],
): Array<{ find: RegExp; replacement: string }> {
  // M69: upward from the member, bounded by the root that governs the install.
  // A member inheriting the workspace tsconfig used to get no aliases at all.
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  const tsconfigPath = findCompilerConfig(projectRoot, workspaceRoot);
  if (!tsconfigPath) return [];
  const configDir = path.dirname(tsconfigPath);

  let options: ts.CompilerOptions;
  try {
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (configFile.error) {
      process.stderr.write(
        `Warning: could not parse tsconfig at ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, " ")}\n`,
      );
      return [];
    }
    // parseJsonConfigFileContent resolves extends (string and array), JSONC,
    // and trailing commas; baseUrl comes back absolute.
    options = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      configDir,
      undefined,
      tsconfigPath,
    ).options;
  } catch (err) {
    process.stderr.write(
      `Warning: could not parse tsconfig at ${tsconfigPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return [];
  }

  const paths = options.paths;
  if (!paths) {
    return options.baseUrl ? baseUrlAliases(options.baseUrl, projectRoot, workspaceRoot) : [];
  }

  // Alias base: resolved baseUrl when set; else the directory of the config
  // that declared "paths" (pathsBasePath, internal but stable), else the
  // tsconfig's own directory.
  const base =
    options.baseUrl ?? (options as { pathsBasePath?: string }).pathsBasePath ?? configDir;

  const aliases: Array<{ find: RegExp; replacement: string }> = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!targets.length) continue;
    // First target only: Vite aliases support a single replacement.
    const target = targets[0];
    if (pattern.endsWith("/*") && target.endsWith("/*")) {
      const prefix = pattern.slice(0, -2);
      const dir = path.resolve(base, target.slice(0, -2)).replace(/\\/g, "/");
      aliases.push({ find: new RegExp(`^${escapeRegex(prefix)}/`), replacement: dir + "/" });
    } else if (pattern.includes("*") || target.includes("*")) {
      // Any other wildcard shape (one side starred, or a star that is not a
      // whole trailing segment) has no Vite alias that means the same thing.
      warningsOut?.push(ALIAS_SHAPE_WARNING(pattern, target));
    } else {
      const resolved = path.resolve(base, target).replace(/\\/g, "/");
      aliases.push({ find: new RegExp(`^${escapeRegex(pattern)}$`), replacement: resolved });
    }
  }
  return aliases;
}

// M69: Vite serves nothing outside its allow list, and the harness root is the
// member package. An alias into a sibling package or into a linked install of
// this tool is outside it. Undefined keeps Vite's own defaults, which is every
// project whose targets are all inside the member root.
// M73: extraDirs carries directories no alias names — the component's own
// directory when its import routes through /@fs/. An empty list reproduces the
// alias-only answer exactly, undefined included.
export function fsAllowDirs(
  memberRoot: string,
  workspaceRoot: string,
  aliases: Array<{ replacement: string }>,
  extraDirs: string[] = [],
): string[] | undefined {
  const forward = (p: string) => path.resolve(p).replace(/\\/g, "/");
  const targets = aliases.map(({ replacement }) => {
    const trimmed = replacement.replace(/[\\/]+$/, "");
    if (!trimmed) return forward(replacement);
    try {
      if (fs.statSync(trimmed).isDirectory()) return forward(trimmed);
    } catch {
      // A stale alias target: its parent is the directory that would hold it.
    }
    return forward(path.dirname(trimmed));
  });

  const inside = (dir: string) => {
    const relative = path.relative(memberRoot, dir);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  const outside = [...targets, ...extraDirs.map(forward)].filter((dir) => !inside(dir));
  if (outside.length === 0) return undefined;
  return [...new Set([forward(memberRoot), forward(workspaceRoot), ...outside])];
}

export function detectScaleExport(filePath: string): boolean {
  const content = fs.readFileSync(filePath, "utf-8");
  return /export\s+(?:function|const)\s+scale\b/.test(content);
}

// M65: named after the file, listed so the message is a menu rather than a
// rejection.
export function targetNotFoundMessage(
  filePath: string,
  target: string,
  available: string[],
): string {
  const where = path.basename(filePath);
  return available.length > 0
    ? `Export "${target}" not found in ${where}. Available component exports: ${available.join(", ")}`
    : `Export "${target}" not found in ${where}, which exports no components.`;
}

// Selection order (M24 D2, M58/M65 normalization): explicit `#Export` target >
// default export > file-stem match among named exports after dropping
// non-alphanumerics > first PascalCase export in source order > filename
// fallback. isDefaultOnly is true iff the chosen component is importable as a
// default import.
export function detectComponentExport(
  filePath: string,
  target?: string,
): {
  name: string;
  isDefaultOnly: boolean;
} {
  // One SFC, one component, always the default export: there is nothing to
  // select and the file is not TypeScript, so the AST walker never runs on it.
  if (isVueFile(filePath)) {
    const name = vueComponentName(filePath);
    if (target && target !== name) throw new Error(targetNotFoundMessage(filePath, target, [name]));
    return { name, isDefaultOnly: true };
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const exports = scanExports(content, filePath);

  if (target) {
    const named = exports.find((e) => e.name === target);
    if (!named) {
      throw new Error(targetNotFoundMessage(filePath, target, exports.map((e) => e.name)));
    }
    return { name: named.name, isDefaultOnly: named.isDefault };
  }

  const defaultExport = exports.find((e) => e.isDefault);
  if (defaultExport) return { name: defaultExport.name, isDefaultOnly: true };

  const stem = normalizeComponentName(path.basename(filePath, path.extname(filePath)));
  const stemMatch = exports.find((e) => normalizeComponentName(e.name) === stem);
  if (stemMatch) return { name: stemMatch.name, isDefaultOnly: false };

  if (exports.length > 0) return { name: exports[0].name, isDefaultOnly: false };

  // Fallback: derive from filename, assume default export
  const basename = path.basename(filePath, path.extname(filePath));
  const name = basename.charAt(0).toUpperCase() + basename.slice(1);
  return { name, isDefaultOnly: true };
}

function collectComponents(node: CompositionNode, set: Set<string>): void {
  if (node.component !== "__text__") set.add(node.component);
  for (const child of node.children) collectComponents(child, set);
}

function nodeToJsx(node: CompositionNode): string {
  if (node.component === "__text__") {
    return JSON.stringify(node.props.text ?? "");
  }

  const propsEntries = Object.entries(node.props);
  const propsStr = propsEntries
    .map(([k, v]) => {
      if (typeof v === "boolean") return v ? k : `${k}={false}`;
      if (typeof v === "string") return `${k}=${JSON.stringify(v)}`;
      return `${k}={${JSON.stringify(v)}}`;
    })
    .join(" ");

  const opening = propsStr ? `<${node.component} ${propsStr}>` : `<${node.component}>`;

  if (node.children.length === 0) {
    return propsStr ? `<${node.component} ${propsStr} />` : `<${node.component} />`;
  }

  const childrenJsx = node.children.map(nodeToJsx).join("\n");
  return `${opening}\n${childrenJsx}\n</${node.component}>`;
}

export function compositionToJsx(tree: CompositionTree): string {
  if (tree.structure.length === 0) return "";
  return nodeToJsx(tree.structure[0]);
}

// A namespace import alongside the default binding: a missing `viewport`
// export must not become a link-time SyntaxError in the browser.
export function wrapImportLine(wrapRelative?: string): string {
  return wrapRelative
    ? `import __120fpsWrap, * as __120fpsWrapModule from "/${wrapRelative}";\n`
    : "";
}

// `strict` is opt-in because only the measurement templates declare the strict
// bindings; the React probe entry shares this helper without them.
export function renderTreeHelper(wrapRelative?: string, strict?: boolean): string {
  const el = strict ? "__120fpsInStrict(el)" : "el";
  return wrapRelative
    ? `const renderTree = (el: any) => root.render(__120fpsWrap ? createElement(__120fpsWrap, null, ${el}) : ${el});`
    : `const renderTree = (el: any) => root.render(${el});`;
}

// StrictMode nests inside the provider wrapper, so the double-invoke cost
// measured is the component's and not the providers'. Named __120fpsInStrict,
// not __120fpsWrapStrict: an entry without a wrapper must not mention
// __120fpsWrap at all.
export function strictBlock(): string {
  return `const __120fpsStrict = new URLSearchParams(location.search).get("strict") === "1";
const __120fpsInStrict = (el: any) => __120fpsStrict ? createElement(StrictMode, null, el) : el;`;
}

// M44. Functions and JSX cannot cross the CDP boundary, so combo generation
// carries their position instead and the entry substitutes the real value at
// render time. Literal preset values never become refs: they travel as
// themselves, so deltas and matrix cells compare real data.
export function presetImportLine(presetRelative?: string): string {
  return presetRelative
    ? `import __120fpsPresets from "/${presetRelative}";\n`
    : "";
}

export function presetResolverBlock(presetRelative?: string): string {
  if (!presetRelative) return "";
  return `
const __120fpsResolveProps = (props: any) => {
  const out: any = { ...props };
  for (const key of Object.keys(out)) {
    const value = out[key];
    if (value && typeof value === "object" && "__120fps_preset" in value) {
      const pool = (__120fpsPresets as any)[value.__120fps_preset];
      out[key] = Array.isArray(pool) ? pool[value.index] : pool;
    }
  }
  return out;
};
`;
}

// Substituted once at each entry point rather than at every render site, so
// scale fan-outs and composed scenes get resolved props without extra cases.
export function presetResolveStatement(presetRelative?: string): string {
  return presetRelative ? "props = __120fpsResolveProps(props);" : "";
}

// M41. Bounded because an unbounded setup would surface as a bare readiness
// timeout 30s later, naming the harness instead of the wrapper.
export const WRAPPER_SETUP_TIMEOUT_MS = 15000;

// Top-level await ahead of the control API assignment: readiness implies setup
// completed, so a fetch mock is installed before the first render. A rejection
// fails module evaluation, which reaches the run as a captured page error.
export function setupBlock(wrapRelative?: string): string {
  if (!wrapRelative) return "";
  return `
const __120fpsSetup = (__120fpsWrapModule as any).setup;
if (typeof __120fpsSetup === "function") {
  await Promise.race([
    Promise.resolve(__120fpsSetup()),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("120fps: wrapper setup did not finish within ${WRAPPER_SETUP_TIMEOUT_MS}ms")),
        ${WRAPPER_SETUP_TIMEOUT_MS},
      ),
    ),
  ]);
}
`;
}

// Session-scoped, not per-unmount: setup runs once and later samples depend on
// what it installed, so tearing it down between samples would dismantle the
// mocks the measurement needs. Measurement sessions call this before disposing.
export function setupApiBlock(wrapRelative?: string): string {
  if (!wrapRelative) return "";
  return `
(window as any).__120fps.hasSetup = typeof __120fpsSetup === "function";
(window as any).__120fps.teardown = async () => {
  const __120fpsTeardown = (__120fpsWrapModule as any).teardown;
  if (typeof __120fpsTeardown === "function") await __120fpsTeardown();
};
`;
}

function viewportBlock(wrapRelative?: string): string {
  if (!wrapRelative) return "";
  return `
const __120fpsViewport = (__120fpsWrapModule as any).viewport;
if (__120fpsViewport) (window as any).__120fps.viewport = __120fpsViewport;
`;
}

export interface EntryOptions {
  componentRelative: string;
  componentName: string;
  isDefaultExport: boolean;
  hasScale: boolean;
  wrapRelative?: string;
  cssImports?: string[];
  presetRelative?: string;
  // Defaults to React, so every existing caller produces the entry it did before.
  renderer?: Renderer;
}

// The renderer supplies four things: the import block, the mount body, the
// unmount body, and `renderTree`. Everything around them: the M25 stylesheet
// block, the M41 setup/teardown blocks, the M44 preset resolver, the M26
// single-render-site rule: is renderer-independent and shared.
export function generateEntry(opts: EntryOptions): string {
  return opts.renderer === "vue" ? generateVueEntry(opts) : generateReactEntry(opts);
}

// Vue batches updates into a microtask queue drained on nextTick(), so the
// control API awaits it before resolving `rerender`. Resolving earlier would
// time scheduling a rerender rather than performing one, and the caller's
// double-rAF fence proves a frame was presented, not that the queue drained
// into it: a wrong answer here reports implausibly fast rerenders instead of
// failing.
export function generateVueEntry(opts: EntryOptions): string {
  const { componentRelative, componentName, hasScale, wrapRelative, cssImports, presetRelative } =
    opts;

  const importLine = `import ${componentName}${hasScale ? ", { scale as __120fps_scale }" : ""} from "/${componentRelative}";`;

  // Auto-scale fans N instances out inside one element, wrapped once (M26).
  const scaleBranch = hasScale
    ? `  if (typeof props.__120fps_scaleN === "number" && typeof __120fps_scale === "function") {
    return __120fps_scale(props.__120fps_scaleN);
  }`
    : `  if (typeof props.__120fps_scaleN === "number") {
    const { __120fps_scaleN: _n, ...rest } = props;
    return h("div", null, Array.from({ length: props.__120fps_scaleN }, (_, i) =>
      h(${componentName}, { ...rest, key: i })));
  }`;

  return `
${cssImportBlock(cssImports)}import { createApp, h, nextTick, shallowRef } from "vue";
${wrapImportLine(wrapRelative)}${presetImportLine(presetRelative)}${importLine}

const container = document.getElementById("root")!;
// A plain object per render, out of a shallowRef: the component sees the same
// unproxied props a parent would hand it, and a new identity patches the child
// instead of remounting it.
const propsRef = shallowRef<any>({});
let app: any = null;
let mounted = false;
let wrapperOnly = false;

const renderComponent = () => {
  const props = propsRef.value;
${scaleBranch}
  return h(${componentName}, { ...props });
};
${vueRenderTreeHelper(wrapRelative)}
const __120fpsRoot = { render: () => renderTree(wrapperOnly ? null : renderComponent()) };

const startApp = () => {
  app = createApp(__120fpsRoot);
  app.mount(container);
  mounted = true;
};
const stopApp = () => {
  if (mounted) {
    app.unmount();
    app = null;
    mounted = false;
  }
};
${presetResolverBlock(presetRelative)}${setupBlock(wrapRelative)}
(window as any).__120fps = {
  mount(props: any = {}) {
    ${presetResolveStatement(presetRelative)}
    stopApp();
    wrapperOnly = false;
    propsRef.value = props;
    startApp();
  },
  mountWrapperOnly() {
    stopApp();
    wrapperOnly = true;
    propsRef.value = {};
    startApp();
  },
  unmount() {
    stopApp();
  },
  async rerender(props: any = {}) {
    ${presetResolveStatement(presetRelative)}
    propsRef.value = props;
    await nextTick();
  },
  getContainer() {
    return container;
  },
};
${setupApiBlock(wrapRelative)}${viewportBlock(wrapRelative)}
`;
}

// The default slot keeps the wrapper outside the component exactly as
// createElement(wrap, null, el) does on the React path.
export function vueRenderTreeHelper(wrapRelative?: string): string {
  return wrapRelative
    ? `const renderTree = (node: any) => __120fpsWrap ? h(__120fpsWrap, null, { default: () => node }) : node;`
    : `const renderTree = (node: any) => node;`;
}

function generateReactEntry(opts: EntryOptions): string {
  const { componentRelative, componentName, isDefaultExport, hasScale, wrapRelative, cssImports, presetRelative } = opts;

  const importLine = isDefaultExport
    ? `import ${componentName}${hasScale ? ", { scale as __120fps_scale }" : ""} from "/${componentRelative}";`
    : `import { ${componentName} as Component${hasScale ? ", scale as __120fps_scale" : ""} } from "/${componentRelative}";`;

  const componentRef = isDefaultExport ? componentName : "Component";

  const autoScaleRender = `if (typeof props.__120fps_scaleN === "number") {
      const n = props.__120fps_scaleN;
      const { __120fps_scaleN: _, ...restProps } = props;
      renderTree(createElement("div", null,
        ...Array.from({ length: n }, (_, i) => createElement(${componentRef}, { ...restProps, key: i }))
      ));
    } else {
      renderTree(createElement(${componentRef}, props));
    }`;

  const render = hasScale
    ? `if (typeof props.__120fps_scaleN === "number" && typeof __120fps_scale === "function") {
      renderTree(__120fps_scale(props.__120fps_scaleN));
    } else {
      renderTree(createElement(${componentRef}, props));
    }`
    : autoScaleRender;

  return `
${cssImportBlock(cssImports)}import { createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
${wrapImportLine(wrapRelative)}${presetImportLine(presetRelative)}${importLine}

const container = document.getElementById("root")!;
let root = createRoot(container);
let mounted = false;
${strictBlock()}
${renderTreeHelper(wrapRelative, true)}
${presetResolverBlock(presetRelative)}${setupBlock(wrapRelative)}
(window as any).__120fps = {
  mount(props: any = {}) {
    ${presetResolveStatement(presetRelative)}
    if (mounted) {
      root.unmount();
      root = createRoot(container);
    }
    ${render}
    mounted = true;
  },
  mountWrapperOnly() {
    if (mounted) {
      root.unmount();
      root = createRoot(container);
    }
    renderTree(null);
    mounted = true;
  },
  unmount() {
    if (mounted) {
      root.unmount();
      root = createRoot(container);
      mounted = false;
    }
  },
  rerender(props: any = {}) {
    ${presetResolveStatement(presetRelative)}
    ${render}
  },
  getContainer() {
    return container;
  },
};
${setupApiBlock(wrapRelative)}${viewportBlock(wrapRelative)}
`;
}

export function generateComposedEntry(
  componentRelative: string,
  tree: CompositionTree,
  exports?: ExportInfo[],
  wrapRelative?: string,
  cssImports?: string[],
): string {
  const components = new Set<string>();
  for (const node of tree.structure) collectComponents(node, components);

  const defaultExports = new Set(exports?.filter((e) => e.isDefault).map((e) => e.name) ?? []);
  const namedImports = [...components].filter((n) => !defaultExports.has(n)).sort();
  const defaultImport = [...components].find((n) => defaultExports.has(n));

  const parts: string[] = [];
  if (defaultImport) parts.push(defaultImport);
  if (namedImports.length > 0) parts.push(`{ ${namedImports.join(", ")} }`);
  const importLine = `import ${parts.join(", ")} from "/${componentRelative}";`;
  const jsx = compositionToJsx(tree);

  return `
${cssImportBlock(cssImports)}import { createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
${wrapImportLine(wrapRelative)}${importLine}

const ComposedScene = () => (
${jsx}
);

const container = document.getElementById("root")!;
let root = createRoot(container);
let mounted = false;
${strictBlock()}
${renderTreeHelper(wrapRelative, true)}
${setupBlock(wrapRelative)}
(window as any).__120fps = {
  mount(props: any = {}) {
    if (mounted) {
      root.unmount();
      root = createRoot(container);
    }
    renderTree(<ComposedScene {...props} />);
    mounted = true;
  },
  mountWrapperOnly() {
    if (mounted) {
      root.unmount();
      root = createRoot(container);
    }
    renderTree(null);
    mounted = true;
  },
  unmount() {
    if (mounted) {
      root.unmount();
      root = createRoot(container);
      mounted = false;
    }
  },
  rerender(props: any = {}) {
    renderTree(<ComposedScene {...props} />);
  },
  getContainer() {
    return container;
  },
};
${setupApiBlock(wrapRelative)}${viewportBlock(wrapRelative)}
`;
}
