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

// The sibling that carries a preset's name without its shape. One producer
// for both modes, so the dry run and the real run disclose it in the same
// words.
export function presetShapeDisclosure(
  componentPath: string,
  projectRoot: string,
): string | undefined {
  const sibling = describePresetSibling(componentPath);
  if (sibling === undefined || sibling.shape === "preset") return undefined;
  return PRESET_SHAPE_WARNING(toPosix(path.relative(projectRoot, sibling.path)));
}

// The extraction warnings a preset answers. A collapsed union whose prop
// the preset supplies values for has no subject left: the branch the
// extraction guessed at was replaced by the values the user named, so it is
// dropped rather than re-worded. With no preset candidate on disk the list
// is returned untouched, character for character.
export function remediesAfterPreset(
  warnings: string[],
  appliedPropNames: string[],
  presetFile?: string,
): string[] {
  // The loaded preset governs the wording, the applied names govern the
  // filter: a preset whose keys miss the extracted schema applies nothing yet
  // is still on disk, so the remedy still must not ask for it.
  const named = presetFile
    ? warnings.map((warning) => remedyNamesLoadedPreset(warning, presetFile))
    : warnings;
  if (appliedPropNames.length === 0) return named;
  return named.filter((warning) => !presetAnswersRemedy(warning, appliedPropNames));
}

// The predicate both modes share: the dry run filters a list with it, the real
// run's `onWarning` filters one warning at a time as extraction produces it.
export function presetAnswersRemedy(warning: string, appliedPropNames: string[]): boolean {
  return appliedPropNames.some(
    (name) => warning.includes(`prop "${name}"`) && warning.includes("is a union of"),
  );
}

// A remedy the preset did not answer still prints, but it must not ask for
// a file the run already loaded. The clause names the loaded preset
// instead, and the rest of the sentence is untouched.
export function remedyNamesLoadedPreset(warning: string, presetFile: string): string {
  return warning.replace(
    /Add (\S+\.props\.tsx?) to /,
    `The applied preset ${presetFile} is already loaded; extend it to `,
  );
}

export const ZERO_PROPS_WARNING =
  "No props extracted: component measured with empty props only; if the component has typed props, extraction may have failed";

// ZERO_PROPS_WARNING floats a possible malfunction ("extraction may have
// failed"). Whenever the same run already named the actual cause of the
// zero count — a Vue scope exclusion ADR 0002 defines, a `defineProps<T>()`
// type argument that did not resolve, or a JS component with no
// declaration to bind — that phrase is false and must not stack on top of
// the disclosure that explains it. A re-exporting file is the same case:
// the measured file only re-exports the component, the props on the table
// are the declaring module's, and both the dry run and the real run print
// this same text to name the same two modules.
export function RE_EXPORT_MEASURED_DISCLOSURE(barrel: string, module: string): string {
  return `re-export of ${barrel}: measuring ${module}`;
}

// The specifier the barrel re-exports resolves to nothing on disk, so no
// props table could have been filled. A cause the filesystem decides,
// stated instead of ZERO_PROPS_WARNING's floated "extraction may have
// failed".
export function UNRESOLVED_RE_EXPORT_WARNING(barrel: string, specifier: string): string {
  return (
    `${barrel} re-exports ${specifier}, which did not resolve: no props were read there`
  );
}

const UNRESOLVED_RE_EXPORT_SIGNATURE = / re-exports .+, which did not resolve: no props were read there$/;

// Read evidence for the provide/inject hint. A mount abort throws before
// any report exists, so the SFC is re-read here, on the failure path only.
// No compiler, an unreadable file or a malformed SFC all mean the run read
// no `inject(` call, and a hint may not name a cause the run did not read.
// The read covers `<script setup>` only: parseSfcScript (project/vue-sfc.ts)
// returns undefined without one, so an Options-API SFC whose setup()
// injects records false and prints no hint. A read or compiler failure is a
// different case from "no inject( call", so it is disclosed rather than
// swallowed.
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

// The config file and the keys the harness read and could not honor, as
// `VITE_CONFIG_IGNORED_WARNING` (harness/vite-config.ts) recorded them for
// this run. Read from the run's own warnings rather than a passed
// `ViteConfigData`, so the hint may name only what is here. Two wordings
// are live: the key-only sentence and the one a config with a named plugin
// list prints ("... declares resolve.alias and plugins the harness cannot
// honor: react — ..."). A `plugins` value that is not an array literal
// still carries no names and keeps the key-only sentence, so the scan reads
// either and normalizes to the key list.
const VITE_CONFIG_IGNORED_SHAPE =
  /^(\S+) declares (.+?)(?:, which the harness read but cannot honor: the project's Vite config is never executed| the harness cannot honor: )/;

export function viteConfigIgnoredKeys(
  warnings: string[],
): { viteConfig: { file: string; ignoredKeys: string[] } } | undefined {
  // VITE_CONFIG_PREPROCESSOR_OPTION_WARNING (harness/vite-config.ts) opens
  // with the identical prefix, so the first match is not necessarily the
  // ignored-keys warning. Only a warning that carries `plugins` can feed
  // this hint, so that is what the scan keeps.
  for (const warning of warnings) {
    const match = VITE_CONFIG_IGNORED_SHAPE.exec(warning);
    if (!match) continue;
    const ignoredKeys = match[2]!.split(", ").flatMap((key) => key.split(" and "));
    if (!ignoredKeys.includes("plugins")) continue;
    return { viteConfig: { file: match[1]!, ignoredKeys } };
  }
  return undefined;
}

// The note is true only about plugins the run did not apply.
// `@vitejs/plugin-vue` declared in a config the harness loads the same
// plugin for is not a dropped plugin, and a note listing it sends a reader
// after a difference that does not exist. A declared name matches a
// transform by the recognizer code or by the factory the harness imports
// for it.
function honoredPluginNames(appliedTransforms: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const plugin of SUPPORTED_TRANSFORM_PLUGINS) {
    if (!appliedTransforms.includes(plugin.code)) continue;
    names.add(plugin.code);
    if (plugin.exportName) names.add(plugin.exportName);
  }
  return names;
}

// The note the run printed is rebuilt, never edited as text: the same
// constructor (VITE_CONFIG_IGNORED_WARNING) is fed the plugins that are
// still news to the reader. When none are left the `plugins` key goes with
// them, and a config that had no other ignored key loses the note entirely.
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

// The one entry point both modes use, so `--explain-props` and the real run
// cannot disagree about which plugins the run applied. Reads the same two
// sources the run itself reads (the config's text, the installed
// transforms) and nothing that only exists after a measurement.
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

// detectComponentExport resolving to the file's own marked `export default`
// is correct by JS/TS export semantics, not a bug in the file's own
// authoring choice: this never changes *which* export is picked. It only
// surfaces the existing #ExportName escape hatch when the resolved export
// carries a degenerate-flagged required prop and an unpicked export in the
// same file has an all-non-degenerate schema. Both the dry run and the real
// run call this, so the single most actionable sentence for the failure
// ("Target it with #ExportName") appears in both, not only in the cheaper
// path; it is AST work only, with no browser and no build.
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

// A fixture or an auto-composed scene supplies the render itself, so the
// run measures one combo of `{}`; a component whose props were never
// applied still needs this said explicitly, not left implicit in a clean
// report.
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

// Whether the per-combo render-health gate or its curve-mode equivalent (a
// run warning) declared this run's render broken.
export function renderFailed(report: Report): boolean {
  if (report.combos.some((combo) => combo.renderHealth === "error")) return true;
  return (report.warnings ?? []).some((warning) => /^scale point N=/.test(warning));
}
