import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { findWorkspaceRoot, isPackageAvailable, isPackageDeclared } from "./model.js";

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

// M83 #8 (primevue-Probe1): resolution via the hoisted-transitive-copy
// fallback (isInstalledOnResolutionChain, inside isPackageAvailable) is
// correct and by design per M75 — only the disclosure was missing. A plugin
// found only that way, not declared in this project's own package.json, gets
// named so a stricter installer (no hoisting) is not a surprise later.
export function detectProjectTransforms(
  projectRoot: string,
  workspaceRoot: string = findWorkspaceRoot(projectRoot),
  onWarning?: (warning: string) => void,
): TransformPlugin[] {
  const matched = SUPPORTED_TRANSFORM_PLUGINS.filter((entry) =>
    isPackageAvailable(entry.packageName, projectRoot, workspaceRoot),
  );
  for (const entry of matched) {
    if (!isPackageDeclared(entry.packageName, projectRoot, workspaceRoot)) {
      onWarning?.(HOISTED_TRANSFORM_WARNING(entry.packageName));
    }
  }
  return matched;
}

export const HOISTED_TRANSFORM_WARNING = (packageName: string): string =>
  `${packageName} was found via a hoisted transitive install, not declared in this project's own ` +
  "package.json; a stricter installer (no hoisting) would not resolve it.";

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
