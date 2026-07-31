import { createServer, type ViteDevServer } from "vite";
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { CompositionTree, CompositionNode, ExportInfo } from "./composition.js";
import { scanExports } from "./prop-gen.js";

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
  { module: "next-video/player", shimFile: "next-video-player.js" },
];

export function detectNextJs(projectRoot: string): boolean {
  const pkgPath = path.join(projectRoot, "package.json");
  if (!fs.existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return "next" in deps;
  } catch {
    return false;
  }
}

export function buildShimAliases(
  hasNextJs: boolean,
): Array<{ find: RegExp; replacement: string }> {
  if (!hasNextJs) return [];
  const shimDir = path.resolve(import.meta.dirname ?? __dirname, "shims");
  return SHIM_MODULES.map((entry) => {
    const escaped = entry.module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return {
      find: new RegExp(`^${escaped}$`),
      replacement: path.join(shimDir, entry.shimFile),
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
}

export interface BuildHarnessOptions {
  composition?: CompositionTree;
  exports?: ExportInfo[];
  noShims?: boolean;
  wrapPath?: string;
  cssFiles?: string[];
  reactCompiler?: boolean;
}

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
  const pkgPath = path.join(projectRoot, "package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return "@tailwindcss/vite" in deps;
  } catch {
    return false;
  }
}

// Loaded from the project's own node_modules: the harness never carries a
// Tailwind version of its own. Import failure is non-fatal — PostCSS may still
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
export function detectReactCompiler(projectRoot: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));
    if (typeof pkg !== "object" || pkg === null) return false;
    for (const section of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
      if (section === null || typeof section !== "object" || Array.isArray(section)) continue;
      if (REACT_COMPILER_PACKAGE in section) return true;
    }
    return false;
  } catch {
    return false;
  }
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
      throw new Error(`${REACT_COMPILER_PACKAGE} not found in ${projectRoot}`);
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
// declared here — otherwise Vite discovers it on the first page load and forces
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
// optimizer cache is cold, pre-bundles it, and full-reloads — destroying the
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

// Probe order is significant: first hit wins (W1).
export const WRAPPER_CANDIDATES = [
  "120fps.setup.tsx",
  "120fps.setup.jsx",
  "120fps.setup.ts",
  "120fps.setup.js",
];

export function detectWrapper(projectRoot: string): string | undefined {
  for (const name of WRAPPER_CANDIDATES) {
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

function resolveWrapper(wrapPath: string, projectRoot: string): string {
  const absolute = path.resolve(wrapPath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Wrapper module not found: ${wrapPath}`);
  }
  const relative = path.relative(projectRoot, absolute).replace(/\\/g, "/");
  if (relative.startsWith("../")) {
    throw new Error(
      `Wrapper module ${wrapPath} must live inside the project root ${projectRoot}`,
    );
  }
  if (!hasCallableDefaultExport(fs.readFileSync(absolute, "utf-8"), absolute)) {
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

  // Crash leftovers from previous runs: best-effort removal (M24 D8)
  sweepStaleHarnessDirs(projectRoot);

  // Place harness files inside the target project so Vite resolves aliases
  const harnessDir = fs.mkdtempSync(
    path.join(projectRoot, ".120fps-harness-"),
  );
  const harnessDirName = path.basename(harnessDir);

  const componentRelative = path.relative(projectRoot, absoluteComponentPath).replace(/\\/g, "/");

  const cssFiles = [...new Set((options?.cssFiles ?? []).map((f) => path.resolve(f)))];
  const cssImports = cssFiles.map((f) => cssImportSpecifier(f, projectRoot));

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
    const { name: componentName, isDefaultOnly } = detectComponentExport(absoluteComponentPath);
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
    });
  }

  const indexHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>120fps harness</title></head>
<body><div id="root"></div><script type="module" src="./entry.tsx"></script></body>
</html>`;

  fs.writeFileSync(path.join(harnessDir, "entry.tsx"), entryTsx);
  fs.writeFileSync(path.join(harnessDir, "index.html"), indexHtml);

  const tsconfigAliases = loadTsconfigAliases(projectRoot);
  const hasNextJs = !options?.noShims && detectNextJs(projectRoot);
  const shimAliases = buildShimAliases(hasNextJs);
  const alias = [...tsconfigAliases, ...shimAliases];

  // The wrapper is imported by the entry, so its packages must be pre-bundled
  // too — otherwise the first mount pays Vite's on-demand optimize cost.
  const importedSpecifiers = new Set<string>();
  const externalDeps = [
    ...new Set([
      ...scanExternalDeps(absoluteComponentPath, projectRoot, alias, importedSpecifiers),
      ...(options?.wrapPath
        ? scanExternalDeps(path.resolve(options.wrapPath), projectRoot, alias, importedSpecifiers)
        : []),
    ]),
  ];

  // Shims are keyed by module specifier ("next/image"), which scanExternalDeps
  // collapses to a package name ("next") for optimizeDeps — match on the raw
  // specifiers instead.
  let activeShims: string[] | undefined;
  if (hasNextJs) {
    const shimmed = SHIM_MODULES.filter((s) => importedSpecifiers.has(s.module)).map(
      (s) => s.module,
    );
    activeShims = shimmed.length > 0 ? shimmed : undefined;
  }

  // PostCSS needs no wiring: Vite loads postcss.config.* from its own root,
  // which is already projectRoot. Only the plugin path has to be loaded by hand.
  const plugins: unknown[] =
    cssFiles.length > 0 && detectTailwindVite(projectRoot)
      ? await loadTailwindVitePlugin(projectRoot)
      : [];
  // Appended, never substituted: the Tailwind entries above must survive.
  if (reactCompiler.active) {
    plugins.push(...(await loadReactCompilerPlugin(reactCompiler.pluginPath!)));
  }

  const server = await createServer({
    root: projectRoot,
    logLevel: "silent",
    plugins: plugins as never,
    server: {
      port: 0,
      strictPort: false,
      // With the overlay on, Vite renders transform failures into a DOM element
      // and logs nothing; with it off the client console.errors the full
      // message, which the page-error capture turns into a usable diagnosis.
      hmr: { overlay: false },
    },
    resolve: {
      alias,
      dedupe: ["react", "react-dom"],
    },
    optimizeDeps: {
      include: [
        "react",
        "react-dom/client",
        ...reactJsxRuntimeDeps(projectRoot),
        ...(reactCompiler.active ? reactCompilerRuntimeDeps(projectRoot) : []),
        ...externalDeps,
      ],
    },
  });

  await server.listen();

  const address = server.httpServer?.address();
  let url: string;
  if (address && typeof address === "object") {
    url = `http://localhost:${address.port}/${harnessDirName}/`;
  } else {
    throw new Error("Failed to start Vite dev server");
  }

  const cleanup = async () => {
    await server.close();
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
  };
}

export function findProjectRoot(dir: string): string | undefined {
  let current = dir;
  while (true) {
    if (fs.existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
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

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"];

function resolveLocalImport(
  fromFile: string,
  spec: string,
  projectRoot: string,
  aliases: Array<{ find: RegExp; replacement: string }>,
): string | null {
  let resolved: string;
  if (spec.startsWith(".") || spec.startsWith("/")) {
    resolved = path.resolve(path.dirname(fromFile), spec);
  } else {
    let matched = false;
    let aliasedPath = spec;
    for (const { find, replacement } of aliases) {
      if (find.test(spec)) {
        aliasedPath = spec.replace(find, replacement);
        matched = true;
        break;
      }
    }
    if (!matched) return null;
    resolved = path.isAbsolute(aliasedPath) ? aliasedPath : path.resolve(projectRoot, aliasedPath);
  }

  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  for (const ext of EXTENSIONS) {
    const withExt = resolved + ext;
    if (fs.existsSync(withExt)) return withExt;
  }
  for (const ext of EXTENSIONS) {
    const indexFile = path.join(resolved, "index" + ext);
    if (fs.existsSync(indexFile)) return indexFile;
  }
  return null;
}

export function scanExternalDeps(
  componentPath: string,
  projectRoot: string,
  aliases: Array<{ find: RegExp; replacement: string }>,
  specifiersOut?: Set<string>,
): string[] {
  const externalPkgs = new Set<string>();
  const visited = new Set<string>();
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

    const importRegex = /(?:^|\s)(?:import|export)\s.*?from\s+["']([^"']+)["']|(?:^|\s)import\s+["']([^"']+)["']/gm;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const spec = match[1] ?? match[2];
      if (!spec) continue;

      const localResolved = resolveLocalImport(normalizedFile, spec, projectRoot, aliases);
      if (localResolved) {
        queue.push(localResolved);
      } else if (!spec.startsWith(".") && !spec.startsWith("/")) {
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

export function loadTsconfigAliases(
  projectRoot: string,
): Array<{ find: RegExp; replacement: string }> {
  // Forward slashes: ts.readConfigFile asserts on backslash paths when the
  // config has parse errors (diagnostic fileName is normalized internally).
  const tsconfigPath = path.join(projectRoot, "tsconfig.json").replace(/\\/g, "/");
  if (!fs.existsSync(tsconfigPath)) return [];

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
      projectRoot,
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
  if (!paths) return [];

  // Alias base: resolved baseUrl when set; else the directory of the config
  // that declared "paths" (pathsBasePath, internal but stable), else the
  // tsconfig's own directory.
  const base =
    options.baseUrl ??
    (options as { pathsBasePath?: string }).pathsBasePath ??
    path.dirname(tsconfigPath);

  const aliases: Array<{ find: RegExp; replacement: string }> = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!targets.length) continue;
    // First target only — Vite aliases support a single replacement.
    const target = targets[0];
    if (pattern.endsWith("/*") && target.endsWith("/*")) {
      const prefix = pattern.slice(0, -2);
      const dir = path.resolve(base, target.slice(0, -2)).replace(/\\/g, "/");
      aliases.push({ find: new RegExp(`^${escapeRegex(prefix)}/`), replacement: dir + "/" });
    } else {
      const resolved = path.resolve(base, target).replace(/\\/g, "/");
      aliases.push({ find: new RegExp(`^${escapeRegex(pattern)}$`), replacement: resolved });
    }
  }
  return aliases;
}

export function detectScaleExport(filePath: string): boolean {
  const content = fs.readFileSync(filePath, "utf-8");
  return /export\s+(?:function|const)\s+scale\b/.test(content);
}

// Selection order (M24 D2): default export > file-stem case-insensitive
// match among named exports > first PascalCase export in source order >
// filename fallback. isDefaultOnly is true iff the chosen component is
// importable as a default import.
export function detectComponentExport(filePath: string): {
  name: string;
  isDefaultOnly: boolean;
} {
  const content = fs.readFileSync(filePath, "utf-8");
  const exports = scanExports(content, filePath);

  const defaultExport = exports.find((e) => e.isDefault);
  if (defaultExport) return { name: defaultExport.name, isDefaultOnly: true };

  const stem = path.basename(filePath, path.extname(filePath)).toLowerCase();
  const stemMatch = exports.find((e) => e.name.toLowerCase() === stem);
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
}

export function generateEntry(opts: EntryOptions): string {
  const { componentRelative, componentName, isDefaultExport, hasScale, wrapRelative, cssImports } = opts;

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
${wrapImportLine(wrapRelative)}${importLine}

const container = document.getElementById("root")!;
let root = createRoot(container);
let mounted = false;
${strictBlock()}
${renderTreeHelper(wrapRelative, true)}

(window as any).__120fps = {
  mount(props: any = {}) {
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
    ${render}
  },
  getContainer() {
    return container;
  },
};
${viewportBlock(wrapRelative)}
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
${viewportBlock(wrapRelative)}
`;
}
