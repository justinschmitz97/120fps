import fs from "node:fs";
import path from "node:path";
import { discoverGlobalCss, detectWrapper, findProjectRoot } from "../harness/index.js";
import { detectFramework } from "../project/index.js";
import {
  CSS_PREPROCESSOR_PACKAGES,
  PROJECT_TRANSFORM_WARNING,
  bundledPreprocessor,
  isPackageAvailable,
} from "../project/index.js";
import { findWorkspaceRoot, isVueFile } from "../project/index.js";
import { type CssReport } from "../report/index.js";
import { type AnalyzeOptions } from "./analyze.js";
import { toPosix } from "../shared/index.js";

// The sentence a run prints when Vite falls through to the Sass 120fps declares; matched on, so a
// run never carries two of them.
export const BUNDLED_PREPROCESSOR_DISCLOSED = "falls through to the copy 120fps ships";

// An injected stylesheet is no import edge of the measured graph, so the preflight classification
// never sees it. Its disclosure is the project-transform one, produced by that same function, and
// it is emitted only where the transform classification has already had its say.
export function bundledPreprocessorStylesheetWarning(
  files: readonly string[],
  projectRoot: string,
  workspaceRoot: string = findWorkspaceRoot(projectRoot),
): string | undefined {
  for (const file of files) {
    const extension = path.extname(file).toLowerCase();
    const packages = CSS_PREPROCESSOR_PACKAGES[extension];
    if (!packages || !bundledPreprocessor(extension)) continue;
    if (packages.some((pkg) => isPackageAvailable(pkg, projectRoot, workspaceRoot))) continue;
    return PROJECT_TRANSFORM_WARNING(
      {
        kind: "project-transform",
        chain: [],
        specifier: toPosix(path.relative(projectRoot, file)),
        transformCode: "css-preprocessor",
      },
      "bundled",
    );
  }
  return undefined;
}

// Gated on the mount of `{}` rendering: a component that renders nothing matches no rule anyway.
export async function probeStylesheetMatchStats(
  page: import("playwright").Page,
): Promise<Array<{ file: string; rules: number; matched: number }> | undefined> {
  try {
    const api = await page.evaluate(
      () => typeof (window as any).__120fps?.stylesheetMatchStats === "function",
    );
    if (!api) return undefined;
    await page.evaluate(() => (window as any).__120fps.mount({}));
    const rootElements = await page.evaluate(
      () => document.getElementById("root")?.querySelectorAll("*").length ?? 0,
    );
    const stats = rootElements > 0
      ? await page.evaluate(() => (window as any).__120fps.stylesheetMatchStats())
      : undefined;
    await page.evaluate(() => (window as any).__120fps.unmount());
    return stats as Array<{ file: string; rules: number; matched: number }> | undefined;
  } catch {
    // A probe never fails a run; the measurement passes mount again and report their own failures.
    return undefined;
  }
}

// The probe searches #root descendants only, so :root rules cannot match; name both readings.
export const STYLESHEET_MATCHED_NOTHING_WARNING = (file: string, rules: number): string =>
  `${file} was injected and none of its ${rules} rules matched an element inside the component's ` +
  "own tree. Either the sheet is scoped under an ancestor the harness does not render (a theme " +
  "root, an app shell wrapper), in which case the render measured unstyled and a --wrap module " +
  "that renders that ancestor fixes it, or the sheet only declares custom properties on :root, " +
  "which do cascade in and are not counted here.";

// One line for many sheets: a run that names each of them drowns the one line that is a finding.
export const STYLESHEET_MATCHED_NOTHING_COLLAPSED_WARNING = (
  named: string[],
  total: number,
  opts: { othersMatched: boolean },
): string => {
  const rest = total > named.length ? ` and ${total - named.length} more` : "";
  const one = total === 1;
  const subject =
    `${total} injected stylesheet${one ? "" : "s"} (${named.join(", ")}${rest}) matched no ` +
    "element inside the component's own tree";
  return opts.othersMatched
    ? `${subject}, while another injected stylesheet did match. ` +
      `${one ? "It carries" : "They carry"} styling this component ` +
      "does not use, so the render was not measured unstyled and nothing needs changing."
    : `${subject}, and no injected stylesheet matched anything. Either they are scoped under an ` +
      "ancestor the harness does not render (a theme root, an app shell wrapper), in which case a " +
      "--wrap module that renders that ancestor fixes it, or they only declare custom properties " +
      "on :root, which do cascade in and are not counted here.";
};

// The size-ranked pick is the one case where "matched nothing" means the pick itself was wrong.
export const STYLESHEET_FALLBACK_MATCHED_NOTHING_WARNING = (file: string, rules: number): string =>
  `${file} was injected as the largest stylesheet under this project, no import chain corroborates ` +
  `that pick, and none of its ${rules} rules matched an element inside the component's own tree — ` +
  "so the pick is most likely the wrong sheet. Pass --css <file> to name the stylesheet this " +
  "component actually loads.";

// A sheet the component was never expected to use gets no --wrap advice.
export function stylesheetMatchWarnings(css: Pick<CssReport, "layer" | "details">): string[] {
  const details = css.details ?? [];
  const zero = details.filter((d) => d.rules > 0 && d.matchedRules === 0);
  if (zero.length === 0) return [];
  const othersMatched = details.some((d) => (d.matchedRules ?? 0) > 0);
  if (css.layer === "largest-fallback") {
    return zero.map((d) => STYLESHEET_FALLBACK_MATCHED_NOTHING_WARNING(d.file, d.rules));
  }
  if (zero.length === 1 && !othersMatched) {
    return [STYLESHEET_MATCHED_NOTHING_WARNING(zero[0].file, zero[0].rules)];
  }
  return [
    STYLESHEET_MATCHED_NOTHING_COLLAPSED_WARNING(
      zero.slice(0, 3).map((d) => d.file),
      zero.length,
      { othersMatched },
    ),
  ];
}

// --no-css wins over an explicit --css, matching --no-wrap/--wrap.
export function resolveCssFiles(
  options: Pick<AnalyzeOptions, "cssFiles" | "noCss">,
  projectRoot: string,
  warningsOut?: string[],
  // wrapPath adds a second graph entry; measuredFile decides "none found" versus an unnamed engine.
  opts?: { wrapPath?: string; measuredFile?: string },
): {
  files: string[];
  autoDetected: boolean;
  layer: CssReport["layer"];
  onlyCandidate?: boolean;
  noEntryInPackage?: boolean;
  runtimeEngines?: string[];
  runtimeEnginesRecognised?: boolean;
  declaredMissing?: Array<{ field: string; path: string; buildCommand?: string }>;
  searchNotes?: string[];
} {
  // layer is what makes "found nothing" and "found nothing because --no-css" distinguishable.
  if (options.noCss) return { files: [], autoDetected: false, layer: "disabled" };

  if (options.cssFiles && options.cssFiles.length > 0) {
    const files: string[] = [];
    for (const raw of options.cssFiles) {
      // Explicit paths are CLI input: resolved against process.cwd(), not projectRoot.
      const resolved = path.resolve(raw);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(resolved);
      } catch {
        throw new Error(`Stylesheet not found: ${raw}`);
      }
      if (!stat.isFile()) throw new Error(`Stylesheet is not a file: ${raw}`);
      if (!files.includes(resolved)) files.push(resolved);
    }
    return { files, autoDetected: false, layer: "explicit" };
  }

  // Only the "none" arm renders them, so every other decision record stays byte-identical.
  const searchNotes: string[] = [];
  const discovered = discoverGlobalCss(projectRoot, warningsOut, {
    ...(opts?.wrapPath ? { extraEntryFiles: [opts.wrapPath] } : {}),
    ...(opts?.measuredFile ? { measuredFile: opts.measuredFile } : {}),
    searchNotesOut: searchNotes,
  });
  const layer: CssReport["layer"] =
    discovered.source === "entry"
      ? "entry-chain"
      : discovered.source === "candidate"
        ? "known-name"
        // A package-declared pick is not a filename match; keep it distinct from the "none" arm.
        : (discovered.source as string) === "package-declared"
          ? "package-declared"
        : discovered.source === "fallback"
          ? "largest-fallback"
          : discovered.source === "runtime"
            ? "runtime"
            : "none";
  return {
    files: discovered.files,
    autoDetected: discovered.files.length > 0,
    layer,
    ...(discovered.onlyCandidate !== undefined ? { onlyCandidate: discovered.onlyCandidate } : {}),
    ...(discovered.noEntryInPackage !== undefined
      ? { noEntryInPackage: discovered.noEntryInPackage }
      : {}),
    ...(discovered.runtimeEngines !== undefined ? { runtimeEngines: discovered.runtimeEngines } : {}),
    ...(discovered.runtimeEnginesRecognised !== undefined
      ? { runtimeEnginesRecognised: discovered.runtimeEnginesRecognised }
      : {}),
    ...(discovered.declaredMissing !== undefined ? { declaredMissing: discovered.declaredMissing } : {}),
    ...(layer === "none" && discovered.declaredMissing === undefined && searchNotes.length > 0
      ? { searchNotes }
      : {}),
  };
}

// A wrapper loaded from the workspace root is otherwise indistinguishable from no wrapper at all.
export function WRAPPER_FROM_WORKSPACE_ROOT_WARNING(wrapPath: string, projectRoot: string): string {
  return (
    `${wrapPath} was found at the workspace root, not in ${projectRoot}; the component's own package ` +
    "declares no 120fps.setup.* wrapper of its own"
  );
}

// --no-wrap wins over an explicit --wrap, matching --no-isolate/--isolate.
export function resolveWrapPath(
  options: Pick<AnalyzeOptions, "wrapPath" | "noWrap">,
  projectRoot: string,
  framework?: string,
  warningsOut?: string[],
): { wrapPath?: string; wrapAutoDetected: boolean } {
  if (options.noWrap) return { wrapAutoDetected: false };
  if (options.wrapPath) {
    const resolved = path.resolve(options.wrapPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Wrapper module not found: ${options.wrapPath}`);
    }
    return { wrapPath: resolved, wrapAutoDetected: false };
  }
  const detected = detectWrapper(projectRoot, framework);
  if (detected) return { wrapPath: detected, wrapAutoDetected: true };

  const workspaceRoot = findWorkspaceRoot(projectRoot);
  if (workspaceRoot !== projectRoot) {
    const fromRoot = detectWrapper(workspaceRoot, framework);
    if (fromRoot) {
      warningsOut?.push(WRAPPER_FROM_WORKSPACE_ROOT_WARNING(fromRoot, projectRoot));
      return { wrapPath: fromRoot, wrapAutoDetected: true };
    }
  }
  return { wrapAutoDetected: false };
}

// Root for 120fps.config.json and 120fps-baseline.json.
export function resolveProjectPaths(resolvedPath: string): {
  projectRoot: string;
  relativeComponent: string;
} {
  const componentDir = path.dirname(resolvedPath);
  const projectRoot = findProjectRoot(componentDir) ?? componentDir;
  const relativeComponent =
    "./" + toPosix(path.relative(projectRoot, resolvedPath));
  return { projectRoot, relativeComponent };
}

// A .vue file overrides the flag: rendererFor (harness/renderer.ts) mounts by extension alone.
export function resolveFramework(
  mode: "react" | "vue" | "vanilla" | "auto",
  projectRoot: string,
  componentPath?: string,
  onWarning?: (warning: string) => void,
): "react" | "vue" | "vanilla" {
  const mounts = componentPath && isVueFile(componentPath) ? "vue" : "react";
  // The flag only selects the post-mount analysis pass, so a disagreement warns instead of losing.
  if (mode !== "auto" && mode !== mounts) {
    onWarning?.(FRAMEWORK_FLAG_NO_MOUNT_EFFECT_WARNING(mode, mounts));
  }
  if (componentPath && isVueFile(componentPath)) return "vue";
  return mode === "auto" ? detectFramework(projectRoot, onWarning) : mode;
}

export const FRAMEWORK_FLAG_NO_MOUNT_EFFECT_WARNING = (requested: string, mounts: string): string =>
  `--framework ${requested} does not change how this file mounts: a component always mounts by its ` +
  `file extension (this file mounts as ${mounts}). The flag only selects which post-mount analysis ` +
  "pass runs.";
