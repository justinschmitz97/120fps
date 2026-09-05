import fs from "node:fs";
import path from "node:path";
import { VITE_CONFIG_IGNORED_WARNING, readViteConfigData, type ViteConfigData } from "../harness/index.js";
import { detectProjectTransforms, SUPPORTED_TRANSFORM_PLUGINS } from "../project/index.js";
import {
  extractProps,
  extractExports,
  isVuePropsScopeExclusionWarning,
  isVueUnresolvedPropsTypeWarning,
  isUntypedJsComponentWarning,
  type PropSchema,
  describePresetSibling,
  PRESET_SHAPE_WARNING,
} from "../props/index.js";
import { isVueFile, loadVueCompiler, parseSfcScript } from "../project/index.js";
import { type Report } from "../report/index.js";
import { toPosix } from "../shared/index.js";

// One producer for both modes, so the dry run and the real run disclose it in the same words.
export function presetShapeDisclosure(
  componentPath: string,
  projectRoot: string,
): string | undefined {
  const sibling = describePresetSibling(componentPath);
  if (sibling === undefined || sibling.shape === "preset") return undefined;
  return PRESET_SHAPE_WARNING(toPosix(path.relative(projectRoot, sibling.path)));
}

// A collapsed union the preset supplies values for has no subject left, so its remedy is dropped.
export function remediesAfterPreset(
  warnings: string[],
  appliedPropNames: string[],
  presetFile?: string,
): string[] {
  // A preset whose keys miss the schema applies nothing, yet is still on disk: reword regardless.
  const named = presetFile
    ? warnings.map((warning) => remedyNamesLoadedPreset(warning, presetFile))
    : warnings;
  if (appliedPropNames.length === 0) return named;
  return named.filter((warning) => !presetAnswersRemedy(warning, appliedPropNames));
}

// Shared: the dry run filters a list, the real run's onWarning filters one warning at a time.
export function presetAnswersRemedy(warning: string, appliedPropNames: string[]): boolean {
  return appliedPropNames.some(
    (name) => warning.includes(`prop "${name}"`) && warning.includes("is a union of"),
  );
}

// A remedy must not ask for a file the run already loaded; only that clause changes.
export function remedyNamesLoadedPreset(warning: string, presetFile: string): string {
  return warning.replace(
    /Add (\S+\.props\.tsx?) to /,
    `The applied preset ${presetFile} is already loaded; extend it to `,
  );
}

export const ZERO_PROPS_WARNING =
  "No props extracted: component measured with empty props only; if the component has typed props, extraction may have failed";

// The measured file only re-exports; the props on the table belong to the declaring module.
export function RE_EXPORT_MEASURED_DISCLOSURE(barrel: string, module: string): string {
  return `re-export of ${barrel}: measuring ${module}`;
}

// A cause the filesystem decides, stated instead of ZERO_PROPS_WARNING's floated malfunction.
export function UNRESOLVED_RE_EXPORT_WARNING(barrel: string, specifier: string): string {
  return (
    `${barrel} re-exports ${specifier}, which did not resolve: no props were read there`
  );
}

const UNRESOLVED_RE_EXPORT_SIGNATURE = / re-exports .+, which did not resolve: no props were read there$/;

// A hint may not name a cause the run did not read, so a failed read is disclosed, not swallowed.
export function SFC_INJECT_READ_FAILED_WARNING(component: string, reason: string): string {
  return (
    `${component} could not be re-read to check for an inject( call (${reason}), so no ` +
    "provide/inject hint is offered for this abort"
  );
}

export async function measuredSfcUsesInject(
  componentPath: string,
  projectRoot: string,
  onWarning?: (warning: string) => void,
): Promise<boolean> {
  if (!isVueFile(componentPath)) return false;
  try {
    const compiler = await loadVueCompiler(projectRoot);
    if (!compiler) return false;
    const source = fs.readFileSync(componentPath, "utf-8");
    // parseSfcScript reads <script setup> only, so an Options-API setup() that injects reads false.
    return parseSfcScript(source, componentPath, compiler)?.usesInject === true;
  } catch (err) {
    onWarning?.(
      SFC_INJECT_READ_FAILED_WARNING(
        toPosix(path.relative(projectRoot, componentPath)),
        err instanceof Error ? err.message : String(err),
      ),
    );
    return false;
  }
}

// VITE_CONFIG_IGNORED_WARNING has two live wordings; both are read and normalized to a key list.
const VITE_CONFIG_IGNORED_SHAPE =
  /^(\S+) declares (.+?)(?:, which the harness read but cannot honor: the project's Vite config is never executed| the harness cannot honor: )/;

export function viteConfigIgnoredKeys(
  warnings: string[],
): { viteConfig: { file: string; ignoredKeys: string[] } } | undefined {
  // VITE_CONFIG_PREPROCESSOR_OPTION_WARNING shares the prefix, so only a plugins hit counts.
  for (const warning of warnings) {
    const match = VITE_CONFIG_IGNORED_SHAPE.exec(warning);
    if (!match) continue;
    const ignoredKeys = match[2]!.split(", ").flatMap((key) => key.split(" and "));
    if (!ignoredKeys.includes("plugins")) continue;
    return { viteConfig: { file: match[1]!, ignoredKeys } };
  }
  return undefined;
}

// A plugin the harness applies is not dropped; listing it sends the reader after nothing.
function honoredPluginNames(appliedTransforms: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const plugin of SUPPORTED_TRANSFORM_PLUGINS) {
    if (!appliedTransforms.includes(plugin.code)) continue;
    names.add(plugin.code);
    if (plugin.exportName) names.add(plugin.exportName);
  }
  return names;
}

// The note is rebuilt through VITE_CONFIG_IGNORED_WARNING, never edited as text.
export function withoutHonoredPluginNote(
  warnings: string[],
  viteConfig: Pick<ViteConfigData, "configFile" | "ignoredKeys" | "pluginNames">,
  appliedTransforms: readonly string[],
): string[] {
  const { configFile, ignoredKeys, pluginNames } = viteConfig;
  if (!configFile || !pluginNames || pluginNames.length === 0) return warnings;
  if (!ignoredKeys.includes("plugins")) return warnings;
  const honored = honoredPluginNames(appliedTransforms);
  const kept = pluginNames.filter((name) => !honored.has(name));
  if (kept.length === pluginNames.length) return warnings;
  const file = path.basename(configFile);
  const printed = VITE_CONFIG_IGNORED_WARNING(file, ignoredKeys, pluginNames);
  const remainingKeys = kept.length > 0 ? ignoredKeys : ignoredKeys.filter((key) => key !== "plugins");
  const replacement =
    kept.length > 0
      ? VITE_CONFIG_IGNORED_WARNING(file, remainingKeys, kept)
      : remainingKeys.length > 0
        ? VITE_CONFIG_IGNORED_WARNING(file, remainingKeys)
        : undefined;
  return warnings.flatMap((warning) =>
    warning === printed ? (replacement ? [replacement] : []) : [warning],
  );
}

// The one entry point both modes use, so --explain-props and the real run cannot disagree.
export function suppressHonoredPluginNote(
  warnings: string[],
  projectRoot: string,
  opts: { noTransforms?: boolean } = {},
): string[] {
  const applied = opts.noTransforms
    ? []
    : detectProjectTransforms(projectRoot).map((plugin) => plugin.code);
  return withoutHonoredPluginNote(warnings, readViteConfigData(projectRoot), applied);
}

export function explainsZeroPropCount(warning: string): boolean {
  return (
    isVuePropsScopeExclusionWarning(warning) ||
    isVueUnresolvedPropsTypeWarning(warning) ||
    isUntypedJsComponentWarning(warning) ||
    UNRESOLVED_RE_EXPORT_SIGNATURE.test(warning)
  );
}

// AST only, so both modes can call it; it never changes which export detectComponentExport picks.
export async function alternativeExportNote(
  resolvedPath: string,
  componentName: string,
  schemas: PropSchema[],
  target: string | undefined,
): Promise<string | undefined> {
  if (target) return undefined;
  if (!schemas.some((s) => s.required && s.degenerate)) return undefined;
  // One component per SFC: a Vue file has no sibling export to retarget.
  if (isVueFile(resolvedPath)) return undefined;
  const exports = (await extractExports(resolvedPath)).map((e) => e.name);
  if (exports.length <= 1) return undefined;
  for (const altName of exports) {
    if (altName === componentName) continue;
    let altSchemas: PropSchema[];
    try {
      altSchemas = await extractProps(resolvedPath, { target: altName, onWarning: () => {} });
    } catch {
      continue; // not every export is a component; skip ones extraction rejects
    }
    if (altSchemas.length > 0 && altSchemas.every((s) => !s.degenerate)) {
      return ALTERNATIVE_EXPORT_WITHOUT_DEGENERATE_PROPS_NOTE(componentName, altName);
    }
  }
  return undefined;
}

// A run that applied none of the component's props says so, rather than printing a clean report.
export const NO_PROPS_MEASURED_WARNING = (useFixture: boolean): string =>
  `measured with no props (props: {}): ${useFixture ? "a fixture file" : "an auto-composed scene"} ` +
  "supplies the render, so none of this component's own extracted props were applied. Any prop " +
  "diagnostics above describe the schema, not what was measured.";

export const ALTERNATIVE_EXPORT_WITHOUT_DEGENERATE_PROPS_NOTE = (
  resolved: string,
  alternative: string,
): string =>
  `${resolved} has a required prop this tool cannot synthesize a real value for; this file also ` +
  `exports ${alternative}, whose props are all synthesizable. Target it with #${alternative} if it is ` +
  "the component you meant to measure.";

// Whether the per-combo gate or its curve-mode equivalent declared this run's render broken.
export function renderFailed(report: Report): boolean {
  if (report.combos.some((combo) => combo.renderHealth === "error")) return true;
  return (report.warnings ?? []).some((warning) => /^scale point N=/.test(warning));
}
