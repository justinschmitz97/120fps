import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  findWorkspaceRoot,
  installedPackageDir,
  isPackageAvailable,
  isPackageDeclared,
  readProjectManifest,
} from "./model.js";

// A curated passthrough, not vite.config wholesale: each entry resolves from the project.
export interface TransformPlugin {
  // Matches a `TRANSFORM_RECOGNIZERS` code, so a diagnosis and a fix share a name.
  code: string;
  packageName: string;
  // The named export carrying the factory, for packages that have no default.
  exportName?: string;
  // Some plugins need options to behave outside their normal dev-server context.
  options?: unknown;
  // The framework the project declares that owns this plugin, when the project itself does not.
  hostPackage?: string;
  // The directory the plugin resolves from; the project root when it is the project's own.
  resolveFrom?: string;
}

// A framework a project depends on may own the transform the project never declares itself.
export const TRANSFORM_HOST_PACKAGES = ["nuxt", "vite"];

// Two levels reach `nuxt` -> `@nuxt/vite-builder` -> `@vitejs/plugin-vue`, which is the deepest
// chain observed; the visit cap bounds a wide dependency set that holds no answer.
const HOST_SEARCH_DEPTH = 2;
const HOST_SEARCH_VISITS = 200;

function realDirectory(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

function declaredDependencies(dir: string): string[] {
  const manifest = readProjectManifest(dir);
  return Object.keys((manifest?.dependencies ?? {}) as Record<string, string>);
}

// A package in the framework's own dependency closure has to declare the plugin and resolve it;
// a copy that only sits on the shared resolution path is the hoisting accident, not this.
function searchHostChain(packageName: string, hostDir: string): string | undefined {
  let frontier = [realDirectory(hostDir)];
  const seen = new Set(frontier);
  let visits = 0;
  for (let depth = 0; depth <= HOST_SEARCH_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of frontier) {
      if (++visits > HOST_SEARCH_VISITS) return undefined;
      const dependencies = declaredDependencies(dir);
      if (dependencies.includes(packageName) && installedPackageDir(packageName, dir)) return dir;
      if (depth === HOST_SEARCH_DEPTH) continue;
      for (const dependency of dependencies) {
        const found = installedPackageDir(dependency, dir);
        if (!found) continue;
        const real = realDirectory(found);
        if (seen.has(real)) continue;
        seen.add(real);
        next.push(real);
      }
    }
    frontier = next;
  }
  return undefined;
}

export function resolveTransformThroughHost(
  packageName: string,
  projectRoot: string,
  workspaceRoot: string = findWorkspaceRoot(projectRoot),
): { hostPackage: string; resolveFrom: string } | undefined {
  for (const hostPackage of TRANSFORM_HOST_PACKAGES) {
    if (!isPackageDeclared(hostPackage, projectRoot, workspaceRoot)) continue;
    const hostDir = installedPackageDir(hostPackage, projectRoot);
    if (!hostDir) continue;
    const resolveFrom = searchHostChain(packageName, hostDir);
    if (resolveFrom) return { hostPackage, resolveFrom };
  }
  return undefined;
}

export const SUPPORTED_TRANSFORM_PLUGINS: TransformPlugin[] = [
  { code: "svgr", packageName: "vite-plugin-svgr" },
  {
    code: "vanilla-extract",
    packageName: "@vanilla-extract/vite-plugin",
    exportName: "vanillaExtractPlugin",
  },
  // Without this entry nothing mounts a .vue file at all.
  { code: "vue", packageName: "@vitejs/plugin-vue" },
];

// Three shapes in the wild: default export, interop double-wrap, named-export-only.
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

// A plugin resolved only through hoisting is named, so a stricter installer is no surprise.
export function detectProjectTransforms(
  projectRoot: string,
  workspaceRoot: string = findWorkspaceRoot(projectRoot),
  onWarning?: (warning: string) => void,
): TransformPlugin[] {
  const matched: TransformPlugin[] = [];
  for (const entry of SUPPORTED_TRANSFORM_PLUGINS) {
    if (isPackageDeclared(entry.packageName, projectRoot, workspaceRoot)) {
      matched.push(entry);
      continue;
    }
    // A framework's own resolution stands on its own, so it is not the hoisting accident below.
    const host = resolveTransformThroughHost(entry.packageName, projectRoot, workspaceRoot);
    if (host) {
      matched.push({ ...entry, hostPackage: host.hostPackage, resolveFrom: host.resolveFrom });
      continue;
    }
    if (isPackageAvailable(entry.packageName, projectRoot, workspaceRoot)) {
      matched.push(entry);
      onWarning?.(HOISTED_TRANSFORM_WARNING(entry.packageName));
    }
  }
  return matched;
}

export const HOISTED_TRANSFORM_WARNING = (packageName: string): string =>
  `${packageName} was found via a hoisted transitive install, not declared in this project's own ` +
  "package.json; a stricter installer (no hoisting) would not resolve it.";

// The harness owns the server lifecycle; a project plugin reaching into it is a failure class.
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
      const projectRequire = createRequire(path.join(entry.resolveFrom ?? projectRoot, "/"));
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
      // Never fatal: an untouched transform still measures, a touched one gets the note.
      onWarning?.(TRANSFORM_LOAD_FAILED_WARNING(entry.code, err instanceof Error ? err.message : String(err)));
    }
  }
  return loaded;
}
