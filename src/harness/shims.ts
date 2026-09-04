import path from "node:path";
import { isPackageAvailable } from "../project/index.js";
import { toPosix } from "../shared/index.js";

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

// M96 (calcom-F2, deferred here by Lane C's spec: the failure happens at
// esbuild's static ES-module resolution layer, before any shim code runs, so
// only this bundler-error layer can catch and re-present it). esbuild's own
// "No matching export" message names the shim's absolute dist/shims path --
// a path inside 120fps's own installation, which M94's own MUST NOT already
// forbids printing. Recognized by exact match against the shim file this
// same process would have aliased to (buildShimAliases' own shimDir
// computation), not by a loose basename guess, so an unrelated file in the
// target repo that happens to share a shim's filename is never misattributed.
const ESBUILD_NO_MATCHING_EXPORT = /No matching export in "([^"]+)" for import "([^"]+)"/;

export function SHIM_EXPORT_MISSING_ERROR(shimModule: string, missingExport: string): string {
  return (
    `"${missingExport}" is not available from 120fps's own "${shimModule}" shim. Pass --no-shims ` +
    "to fall back to the project's real module instead (if it resolves standalone), or report " +
    "this shim gap."
  );
}

export function diagnoseMissingShimExport(message: string): string | undefined {
  const match = ESBUILD_NO_MATCHING_EXPORT.exec(message);
  if (!match) return undefined;
  const filePath = toPosix(match[1]);
  const missingExport = match[2];
  const shimDir = toPosix(path.resolve(import.meta.dirname ?? __dirname, "shims"));
  const entry = SHIM_MODULES.find((s) => `${shimDir}/${s.shimFile}` === filePath);
  if (!entry) return undefined;
  return SHIM_EXPORT_MISSING_ERROR(entry.module, missingExport);
}
