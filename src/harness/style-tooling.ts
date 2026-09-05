import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import {
  findWorkspaceRoot,
  isPackageAvailable,
  readProjectManifest,
  workspaceLevels,
} from "../project/index.js";
import {
  POSTCSS_PLUGIN_UNRESOLVED_WARNING,
  findPostcssConfigAbove,
  findPostcssConfigFile,
  readPostcssPluginDeclarationsAsync,
  unresolvedPostcssPlugins,
} from "./postcss-config.js";
import { isFile, toPosix } from "../shared/index.js";

// What the recogniser can name, not what exists: an unlisted engine reads as "none found".
export const RUNTIME_STYLE_ENGINES = [
  "@ant-design/cssinjs",
  "antd-style",
  "@emotion/react",
  "@emotion/styled",
  "@emotion/css",
  "@griffel/react",
  "@griffel/core",
  "css-render",
  "styled-components",
  "primevue",
];

// An import of one of these from an unlisted package is an observation about one file.
const RUNTIME_STYLE_BINDINGS = new Set(["makeStyles", "createUseStyles", "styled"]);

// Bare specifiers only: a relative import is the project's own code, not an engine.
export function unrecognisedRuntimeStyleEngine(measuredFile: string): string | undefined {
  let sourceText: string;
  try {
    sourceText = fs.readFileSync(measuredFile, "utf-8");
  } catch {
    return undefined;
  }
  const kind = /\.[jt]sx$/i.test(measuredFile) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(measuredFile, sourceText, ts.ScriptTarget.Latest, false, kind);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
    if (RUNTIME_STYLE_ENGINES.includes(specifier)) continue;
    const clause = statement.importClause;
    const named = clause.namedBindings;
    const imported: string[] = [];
    if (clause.name) imported.push(clause.name.text);
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) imported.push((element.propertyName ?? element.name).text);
    }
    if (imported.some((name) => RUNTIME_STYLE_BINDINGS.has(name))) return specifier;
  }
  return undefined;
}

export function detectRuntimeStyleEngines(
  projectRoot: string,
  workspaceRoot: string = findWorkspaceRoot(projectRoot),
): string[] {
  return RUNTIME_STYLE_ENGINES.filter((pkg) => isPackageAvailable(pkg, projectRoot, workspaceRoot));
}

// Vite's root is projectRoot, so an in-root stylesheet is root-absolute; anything else /@fs/.
export function cssImportSpecifier(cssFile: string, projectRoot: string): string {
  const relative = path.relative(projectRoot, cssFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return "/@fs/" + toPosix(cssFile);
  }
  return "/" + toPosix(relative);
}

export function cssImportBlock(specifiers?: string[]): string {
  if (!specifiers || specifiers.length === 0) return "";
  return specifiers.map((s) => `import "${s}";`).join("\n") + "\n";
}

export function detectTailwindVite(projectRoot: string): boolean {
  return isPackageAvailable("@tailwindcss/vite", projectRoot);
}

// Loaded from the project's own node_modules: the harness carries no Tailwind of its own.
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
    // Non-fatal: PostCSS may still be configured, and a missing plugin must not abort a run.
    process.stderr.write(
      `Warning: could not load @tailwindcss/vite from ${projectRoot}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return [];
  }
}

// Recognized so an unstyled-looking number is explainable; no plugin is ever loaded.
export const UNSUPPORTED_STYLE_ENGINES = [
  "unocss",
  "@unocss/vite",
  "@linaria/vite",
  "@linaria/core",
  "@pandacss/dev",
];

// Membership in the import graph, not availability: a mere declaration must not warn.
export function detectUnsupportedStyleEngines(
  _projectRoot: string,
  _workspaceRoot: string,
  importedPackages: readonly string[],
): string[] {
  return UNSUPPORTED_STYLE_ENGINES.filter((pkg) => importedPackages.includes(pkg));
}

export function UNSUPPORTED_STYLE_ENGINE_WARNING(packages: string[]): string {
  return (
    `${packages.join(", ")} generates styles through a build step this harness does not run, so that ` +
    "styling is not replicated and the component may measure unstyled"
  );
}

// Tailwind 3 resolves its config against `process.cwd()`; the member decides, not the shell.
export const TAILWIND_CONFIG_FILES = [
  "tailwind.config.js",
  "tailwind.config.cjs",
  "tailwind.config.mjs",
  "tailwind.config.ts",
];

// Bare `tailwindcss` is the version-3 plugin name; the `@tailwindcss/*` entries are version 4.
function postcssTextDeclaresBareTailwind(text: string): boolean {
  return /(?<![@\w/-])tailwindcss(?![\w/-])/.test(text);
}

// Installed metadata first: a member measured before its install still states its major.
export function installedTailwindVersion(
  memberRoot: string,
  workspaceRoot: string = findWorkspaceRoot(memberRoot),
): string | undefined {
  const versions: string[] = [];
  // An install above the workspace root belongs to the surrounding checkout, not this project.
  for (const level of workspaceLevels(memberRoot, workspaceRoot)) {
    const manifest = readProjectManifest(path.join(level, "node_modules", "tailwindcss"));
    if (typeof manifest?.version === "string") {
      versions.push(manifest.version);
      break;
    }
  }
  for (const level of workspaceLevels(memberRoot, workspaceRoot)) {
    const manifest = readProjectManifest(level);
    for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
      const deps = manifest?.[field] as Record<string, unknown> | undefined;
      const range = deps?.tailwindcss;
      if (typeof range === "string") versions.push(range);
    }
  }
  return versions[0];
}

export function installedTailwindMajor(
  memberRoot: string,
  workspaceRoot: string = findWorkspaceRoot(memberRoot),
): number | undefined {
  const version = installedTailwindVersion(memberRoot, workspaceRoot);
  const major = version === undefined ? null : /(\d+)/.exec(version);
  return major ? Number(major[1]) : undefined;
}

export interface Tailwind3Pipeline {
  postcssConfigFile: string;
  configPath?: string;
  searched: string[];
}

// Undefined when nothing here is a Tailwind 3 PostCSS pipeline; the start directory is no input.
export function resolveTailwind3Config(
  memberRoot: string,
  workspaceRoot: string = findWorkspaceRoot(memberRoot),
): Tailwind3Pipeline | undefined {
  if (detectTailwindVite(memberRoot)) return undefined;
  const postcssConfigFile = findPostcssConfigFile(memberRoot, workspaceRoot);
  if (postcssConfigFile === undefined) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(postcssConfigFile, "utf-8");
  } catch {
    return undefined;
  }
  if (!postcssTextDeclaresBareTailwind(text)) return undefined;
  const major = installedTailwindMajor(memberRoot, workspaceRoot);
  if (major !== undefined && major !== 3) return undefined;
  const searched = workspaceLevels(memberRoot, workspaceRoot);
  for (const level of searched) {
    for (const name of TAILWIND_CONFIG_FILES) {
      const candidate = path.join(level, name);
      if (isFile(candidate)) return { postcssConfigFile, configPath: candidate, searched };
    }
  }
  return { postcssConfigFile, searched };
}

// It names no build script: no script produces a config the repository does not carry.
export function TAILWIND3_CONFIG_MISSING_WARNING(searched: string[], startDir: string): string {
  return (
    `This project builds its CSS with Tailwind 3 through PostCSS, but none of ` +
    `${TAILWIND_CONFIG_FILES.join(", ")} was found in ${searched.join(", ")}. ` +
    `Tailwind then resolves its config from the directory the run started in ` +
    `(${startDir}) and falls back to its default config, whose content list is empty: ` +
    `utility classes and @apply rules resolve to nothing. Add one of those files to ${searched[0]}.`
  );
}

// A path, not an object: Tailwind's context cache is keyed by the config file path.
export function writeAnchoredTailwind3Config(
  memberRoot: string,
  tailwindConfigPath: string,
  outputDir: string,
): string {
  const loadConfigPath = createRequire(path.join(memberRoot, "/")).resolve(
    "tailwindcss/loadConfig",
  );
  const generated = path.join(outputDir, "tailwind.anchored.config.cjs");
  const source = [
    `// Generated by 120fps: the member's own Tailwind config, with every relative`,
    "// `content` glob resolved against the member root instead of the directory",
    "// this run started in.",
    `const path = require("node:path");`,
    `const loaded = require(${JSON.stringify(loadConfigPath)});`,
    "const loadConfig = loaded.default || loaded;",
    `const base = ${JSON.stringify(memberRoot)};`,
    `const config = loadConfig(${JSON.stringify(tailwindConfigPath)});`,
    "const anchor = (glob) => {",
    `  if (typeof glob !== "string") return glob;`,
    `  const negated = glob.startsWith("!");`,
    "  const body = negated ? glob.slice(1) : glob;",
    "  if (path.isAbsolute(body)) return glob;",
    `  return (negated ? "!" : "") + path.resolve(base, body).split(path.sep).join("/");`,
    "};",
    "const content = config.content;",
    "module.exports = Array.isArray(content)",
    "  ? { ...config, content: content.map(anchor) }",
    `  : content && typeof content === "object"`,
    "    ? { ...config, content: { ...content, files: (content.files || []).map(anchor) } }",
    "    : config;",
    "",
  ].join("\n");
  fs.writeFileSync(generated, source);
  return generated;
}

export async function loadTailwind3PostcssPipeline(
  memberRoot: string,
  postcssConfigFile: string,
  tailwindConfigPath: string,
  outputDir?: string,
  onWarning?: (warning: string) => void,
): Promise<{ plugins: unknown[] } | undefined> {
  try {
    const declared = await readPostcssPluginDeclarationsAsync(postcssConfigFile);
    // A `.ts` config or a non-array/object `plugins` leaves the run on the directory search.
    if (declared === undefined) {
      onWarning?.(
        `Could not read a plugin list from ${postcssConfigFile}: Tailwind resolves its own config ` +
          `from the directory this run started in, so the result depends on that directory.`,
      );
      return undefined;
    }
    let configPath = tailwindConfigPath;
    if (outputDir !== undefined) {
      try {
        configPath = writeAnchoredTailwind3Config(memberRoot, tailwindConfigPath, outputDir);
      } catch (err) {
        onWarning?.(
          `Could not anchor the content globs of ${tailwindConfigPath} to ${memberRoot} ` +
            `(${err instanceof Error ? err.message : String(err)}): a relative glob in that config ` +
            `resolves against the directory this run started in, so the CSS built depends on it.`,
        );
      }
    }
    const require = createRequire(path.join(memberRoot, "/"));
    const plugins: unknown[] = [];
    for (const entry of declared) {
      if (entry.name === undefined) {
        plugins.push(entry.instance);
        continue;
      }
      // A member that already pinned a config path had no directory dependence to take away.
      const declaredConfig = (entry.options as Record<string, unknown> | undefined)?.config;
      const options =
        entry.name === "tailwindcss" && declaredConfig === undefined
          ? {
              ...(entry.options as Record<string, unknown> | undefined),
              config: configPath,
            }
          : entry.options;
      const loaded = (await import(pathToFileURL(require.resolve(entry.name)).href)) as {
        default?: unknown;
      };
      const factory = loaded.default ?? loaded;
      plugins.push(
        typeof factory === "function"
          ? (factory as (o?: unknown) => unknown)(options)
          : factory,
      );
    }
    return { plugins };
  } catch (err) {
    onWarning?.(
      `Could not rebuild the PostCSS pipeline from ${postcssConfigFile} with an explicit Tailwind ` +
        `config (${err instanceof Error ? err.message : String(err)}): Tailwind resolves its own ` +
        `config from the directory this run started in, so the result depends on that directory.`,
    );
    return undefined;
  }
}

export interface StyleTooling {
  tailwind: boolean;
  unsupportedEngines: string[];
  postcssConfigDir?: string;
  // The config the harness loads itself, so postcss-load-config never sees the plugin list.
  postcssConfigFile?: string;
  tailwind3ConfigPath?: string;
  tailwind3PostcssConfigFile?: string;
  warnings: string[];
}

// Whether a global stylesheet was found says nothing about whether the plugin is needed.
export function resolveStyleTooling(
  projectRoot: string,
  workspaceRoot: string = findWorkspaceRoot(projectRoot),
  importedPackages: readonly string[] = [],
  startDir: string = process.cwd(),
): StyleTooling {
  const unsupportedEngines = detectUnsupportedStyleEngines(projectRoot, workspaceRoot, importedPackages);
  const postcssConfigDir = findPostcssConfigAbove(projectRoot, workspaceRoot);
  const postcssConfigFile = findPostcssConfigFile(projectRoot, workspaceRoot);
  const tailwind3 = resolveTailwind3Config(projectRoot, workspaceRoot);
  const warnings =
    unsupportedEngines.length > 0 ? [UNSUPPORTED_STYLE_ENGINE_WARNING(unsupportedEngines)] : [];
  if (tailwind3 && tailwind3.configPath === undefined) {
    warnings.push(TAILWIND3_CONFIG_MISSING_WARNING(tailwind3.searched, startDir));
  }
  // Named before anything compiles, so the dry run and the real run print the same line.
  if (postcssConfigFile !== undefined) {
    for (const plugin of unresolvedPostcssPlugins(postcssConfigFile, projectRoot, workspaceRoot)) {
      warnings.push(POSTCSS_PLUGIN_UNRESOLVED_WARNING(postcssConfigFile, plugin.name, plugin.bases));
    }
  }
  return {
    tailwind: detectTailwindVite(projectRoot),
    unsupportedEngines,
    warnings,
    ...(postcssConfigDir ? { postcssConfigDir } : {}),
    ...(postcssConfigFile ? { postcssConfigFile } : {}),
    ...(tailwind3?.configPath
      ? {
          tailwind3ConfigPath: tailwind3.configPath,
          tailwind3PostcssConfigFile: tailwind3.postcssConfigFile,
        }
      : {}),
  };
}
