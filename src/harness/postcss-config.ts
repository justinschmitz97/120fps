import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { findWorkspaceRoot, workspaceLevels } from "../project/index.js";
import { isFile } from "../shared/index.js";

// postcss-load-config's own search places, minus package.json.
export const POSTCSS_CONFIG_FILES = [
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

// The extensions Node loads on its own: a .ts or .yaml config needs a loader the harness lacks.
const LOADABLE_CONFIG_EXTENSIONS = [".js", ".cjs", ".mjs"];

// Vite's own walk stops at the member when the repository root carries only a lockfile.
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

// Vite's own PostCSS search order, so this finds what a run started in the member would.
export function findPostcssConfigFile(
  memberRoot: string,
  workspaceRoot: string = findWorkspaceRoot(memberRoot),
): string | undefined {
  for (const level of workspaceLevels(memberRoot, workspaceRoot)) {
    for (const name of POSTCSS_CONFIG_FILES) {
      const candidate = path.join(level, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

export interface PostcssPluginDeclaration {
  name?: string;
  options?: unknown;
  instance?: unknown;
}

interface LoadedPostcssConfig {
  config: Record<string, unknown>;
  declarations: PostcssPluginDeclaration[];
}

// require() of an ES module answers with the namespace, whose config sits on `default`.
function unwrapDefaultExport(loaded: unknown): unknown {
  if (
    loaded &&
    typeof loaded === "object" &&
    !("plugins" in loaded) &&
    "default" in (loaded as Record<string, unknown>)
  ) {
    return (loaded as { default: unknown }).default;
  }
  return loaded;
}

// Loaded, not parsed: a plugin the member instantiated itself passes through untouched.
function declarationsFrom(config: unknown): LoadedPostcssConfig | undefined {
  if (!config || typeof config !== "object") return undefined;
  const record = config as Record<string, unknown>;
  const plugins = record.plugins;
  if (Array.isArray(plugins)) {
    return {
      config: record,
      declarations: plugins.map((entry) => {
        if (typeof entry === "string") return { name: entry };
        if (Array.isArray(entry) && typeof entry[0] === "string") {
          return { name: entry[0], options: entry[1] };
        }
        return { instance: entry };
      }),
    };
  }
  if (plugins && typeof plugins === "object") {
    return {
      config: record,
      declarations: Object.entries(plugins as Record<string, unknown>)
        // PostCSS's object form disables a plugin with `false`, so a disabled entry produces none.
        .filter(([, options]) => options !== false)
        .map(([name, options]) => ({
          name,
          ...(options === true || options === null || options === undefined ? {} : { options }),
        })),
    };
  }
  return undefined;
}

function requireConfig(file: string): unknown {
  try {
    return unwrapDefaultExport(createRequire(file)(file));
  } catch {
    return undefined;
  }
}

// Sync so `--explain-props` reads the declarations the build reads, from the same module cache.
export function readPostcssPluginDeclarations(file: string): PostcssPluginDeclaration[] | undefined {
  return readPostcssConfig(file)?.declarations;
}

function readPostcssConfig(file: string): LoadedPostcssConfig | undefined {
  if (!LOADABLE_CONFIG_EXTENSIONS.includes(path.extname(file))) return undefined;
  return declarationsFrom(requireConfig(file));
}

// Node before 22.12 refuses require() of an ES module; the dynamic import still loads it.
async function readPostcssConfigAsync(file: string): Promise<LoadedPostcssConfig | undefined> {
  const fromRequire = readPostcssConfig(file);
  if (fromRequire) return fromRequire;
  if (!LOADABLE_CONFIG_EXTENSIONS.includes(path.extname(file))) return undefined;
  try {
    return declarationsFrom(unwrapDefaultExport(await import(pathToFileURL(file).href)));
  } catch {
    return undefined;
  }
}

export async function readPostcssPluginDeclarationsAsync(
  file: string,
): Promise<PostcssPluginDeclaration[] | undefined> {
  return (await readPostcssConfigAsync(file))?.declarations;
}

const CONFIG_MODULE_SPECIFIER = /\bfrom\s*["']([^"']+)["']/g;

// The package that declares the plugins owns them, so its directory is asked first.
export function postcssPluginBases(
  configFile: string,
  memberRoot: string,
  workspaceRoot: string = findWorkspaceRoot(memberRoot),
): string[] {
  const bases: string[] = [];
  const add = (dir: string): void => {
    if (!bases.includes(dir)) bases.push(dir);
  };
  let text = "";
  try {
    text = fs.readFileSync(configFile, "utf-8");
  } catch {
    text = "";
  }
  const require = createRequire(configFile);
  for (const match of text.matchAll(CONFIG_MODULE_SPECIFIER)) {
    let resolved: string;
    try {
      resolved = require.resolve(match[1]);
    } catch {
      continue;
    }
    // A builtin resolves to its own bare name, which names no directory.
    if (path.isAbsolute(resolved)) add(path.dirname(resolved));
  }
  add(path.dirname(configFile));
  add(memberRoot);
  add(workspaceRoot);
  return bases;
}

export function resolvePostcssPlugin(name: string, bases: readonly string[]): string | undefined {
  for (const base of bases) {
    try {
      return createRequire(path.join(base, "/")).resolve(name);
    } catch {
      continue;
    }
  }
  return undefined;
}

export function POSTCSS_PLUGIN_UNRESOLVED_WARNING(
  configFile: string,
  plugin: string,
  bases: readonly string[],
): string {
  return (
    `${configFile} declares the PostCSS plugin ${plugin}, which is installed in none of ` +
    `${bases.join(", ")}; the plugin is skipped, so whatever it contributes is missing from the ` +
    "stylesheets this run compiles"
  );
}

export interface UnresolvedPostcssPlugin {
  name: string;
  bases: string[];
}

// Filesystem-only, so both modes name the same plugins before anything is compiled.
export function unresolvedPostcssPlugins(
  configFile: string,
  memberRoot: string,
  workspaceRoot: string = findWorkspaceRoot(memberRoot),
): UnresolvedPostcssPlugin[] {
  const loaded = readPostcssConfig(configFile);
  if (!loaded) return [];
  const bases = postcssPluginBases(configFile, memberRoot, workspaceRoot);
  const unresolved: UnresolvedPostcssPlugin[] = [];
  for (const declaration of loaded.declarations) {
    if (declaration.name === undefined) continue;
    if (resolvePostcssPlugin(declaration.name, bases) !== undefined) continue;
    unresolved.push({ name: declaration.name, bases });
  }
  return unresolved;
}

export type PostcssPipeline = { plugins: unknown[] } & Record<string, unknown>;

// A plugin list, not a directory: postcss-load-config never sees the Next.js plugin dialect.
export async function loadPostcssConfigPipeline(
  configFile: string,
  memberRoot: string,
  workspaceRoot: string = findWorkspaceRoot(memberRoot),
  onWarning?: (warning: string) => void,
): Promise<PostcssPipeline | undefined> {
  const loaded = await readPostcssConfigAsync(configFile);
  if (!loaded) return undefined;
  const bases = postcssPluginBases(configFile, memberRoot, workspaceRoot);
  const plugins: unknown[] = [];
  for (const declaration of loaded.declarations) {
    if (declaration.name === undefined) {
      plugins.push(declaration.instance);
      continue;
    }
    const entry = resolvePostcssPlugin(declaration.name, bases);
    if (entry === undefined) {
      onWarning?.(POSTCSS_PLUGIN_UNRESOLVED_WARNING(configFile, declaration.name, bases));
      continue;
    }
    let factory: unknown;
    try {
      const module = (await import(pathToFileURL(entry).href)) as { default?: unknown };
      factory = module.default ?? module;
    } catch (err) {
      onWarning?.(
        `${configFile} declares the PostCSS plugin ${declaration.name}, which failed to load from ` +
          `${entry} (${err instanceof Error ? err.message : String(err)}); the plugin is skipped`,
      );
      continue;
    }
    plugins.push(
      typeof factory === "function"
        ? (factory as (options?: unknown) => unknown)(declaration.options)
        : factory,
    );
  }
  const { plugins: _declared, ...options } = loaded.config;
  return { plugins, ...options };
}
