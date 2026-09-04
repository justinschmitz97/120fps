import fs from "node:fs";
import path from "node:path";
import { discoverGlobalCss, detectWrapper, findProjectRoot } from "../harness/index.js";
import { detectFramework } from "../project/index.js";
import { findWorkspaceRoot, isVueFile } from "../project/index.js";
import { type CssReport } from "../report/index.js";
import { type AnalyzeOptions } from "./analyze.js";
import { toPosix } from "../shared/index.js";

// The generated harness entry exposes
// `window.__120fps.stylesheetMatchStats()`: per injected global stylesheet,
// how many of its rules match at least one element under `#root`. A
// stylesheet entirely scoped under an ancestor class the harness never
// renders would inject every rule and match none, so the run would measure
// an unstyled tree while reporting the stylesheet as in use. Probed on a
// deliberate mount of `{}` and gated on that mount actually rendering: a
// component that renders nothing for empty props would match no rule for a
// reason that has nothing to do with the stylesheet, and a warning there
// would be false.
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
    // A probe is never a reason to fail a run: the measurement passes that
    // follow do their own mounting and report their own failures.
    return undefined;
  }
}

// Names the file and what the reader would otherwise have to infer from a
// styled-looking report: that the render was measured as if the stylesheet
// were not there at all. The probe asks
// `#root.querySelector(selectorText)`, which searches descendants of the
// component's container only. A rule selecting `:root`, `html` or `body`
// can never match there even though its custom properties do cascade in, so
// the message names both readings instead of asserting the sheet had no
// effect.
export const STYLESHEET_MATCHED_NOTHING_WARNING = (file: string, rules: number): string =>
  `${file} was injected and none of its ${rules} rules matched an element inside the component's ` +
  "own tree. Either the sheet is scoped under an ancestor the harness does not render (a theme " +
  "root, an app shell wrapper), in which case the render measured unstyled and a --wrap module " +
  "that renders that ancestor fixes it, or the sheet only declares custom properties on :root, " +
  "which do cascade in and are not counted here.";

// --no-css wins over an explicit --css, matching --no-wrap/--wrap. Explicit
// paths resolve against process.cwd() and suppress detection. Detection
// follows the project's own entry imports first and can return several
// files, in import order; whatever it had to guess at travels in
// `warningsOut`. Layer travels with the resolution so analyzeComponent can
// build a CssReport unconditionally: layer is what makes "found nothing"
// and "found nothing because --no-css" distinguishable in the disclosed
// report.
export function resolveCssFiles(
  options: Pick<AnalyzeOptions, "cssFiles" | "noCss">,
  projectRoot: string,
  warningsOut?: string[],
  // `wrapPath` is a second entry into the project's own module graph: the
  // stylesheets a wrapper's setup module imports are exactly the ones the
  // measured render needs, so discovery must walk it alongside the project
  // entry or it misses stylesheets a wrapper imports.
  // `measuredFile` is the component file the run measures. It is the last
  // read discovery has when no stylesheet and no declared engine exist, and
  // it decides between "none found" and an engine the recogniser cannot
  // name.
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
} {
  if (options.noCss) return { files: [], autoDetected: false, layer: "disabled" };

  if (options.cssFiles && options.cssFiles.length > 0) {
    const files: string[] = [];
    for (const raw of options.cssFiles) {
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

  const discovered = discoverGlobalCss(projectRoot, warningsOut, {
    ...(opts?.wrapPath ? { extraEntryFiles: [opts.wrapPath] } : {}),
    ...(opts?.measuredFile ? { measuredFile: opts.measuredFile } : {}),
  });
  const layer: CssReport["layer"] =
    discovered.source === "entry"
      ? "entry-chain"
      : discovered.source === "candidate"
        ? "known-name"
        // A pick made from the measured package's own `style` /
        // `exports["./styles"]` declaration is not a filename match; this
        // arm keeps that layer name distinct from the ternary's `"none"`
        // fallback.
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
  };
}

// A wrapper placed at the workspace root produces total silence, identical
// to no wrapper existing at all; a wrapper that loads from an unexpected
// level must say so.
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

// Root for 120fps.config.json / 120fps-baseline.json: nearest ancestor of the
// component containing package.json, falling back to the component's directory.
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

// Explicit --framework react|vue|vanilla skips detection; auto detects from the
// project's package.json. A `.vue` file overrides both: no flag can make React
// render an SFC, so the file's own type is the stronger evidence.
//
// `rendererFor` (harness/renderer.ts) decides the mount template purely by
// file extension and never reads --framework; the flag only ever gates
// which *post-mount analysis* pass runs. An explicit, non-"auto" request
// that disagrees with what will actually mount (by the same extension check
// performed here) surfaces a warning instead of being silently discarded in
// either direction.
export function resolveFramework(
  mode: "react" | "vue" | "vanilla" | "auto",
  projectRoot: string,
  componentPath?: string,
  onWarning?: (warning: string) => void,
): "react" | "vue" | "vanilla" {
  const mounts = componentPath && isVueFile(componentPath) ? "vue" : "react";
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
