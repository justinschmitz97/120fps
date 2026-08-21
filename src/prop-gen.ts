import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import type { ExportInfo } from "./composition.js";
import {
  isVueFile,
  loadVueCompiler,
  parseSfcScript,
  virtualScriptPath,
  detectOptionsApiProps,
  type SfcScript,
  type VueSfcCompiler,
} from "./vue-sfc.js";
import { detectPropPresets, loadPropPresets, literalValue } from "./prop-presets.js";
import { findCompilerConfig, findProjectRoot, findWorkspaceRoot } from "./project-model.js";

// M36: a fresh ts.Program per extraction re-parses lib.d.ts and the project's
// node_modules type graph every time. Between calls only the component file
// differs, so parsed source files are cached for the process lifetime (keyed
// by options bucket + file stamp, mirroring the LanguageService document
// registry) and programs chain through `oldProgram` within an options bucket.
interface ExtractionCache {
  sourceFiles: Map<string, { sf: ts.SourceFile; mtimeMs: number; size: number }>;
  lastProgram?: ts.Program;
  lastOptionsKey?: string;
  programsCreated: number;
  sourceFilesParsed: number;
}

function emptyExtractionCache(): ExtractionCache {
  return { sourceFiles: new Map(), programsCreated: 0, sourceFilesParsed: 0 };
}

let extractionCache = emptyExtractionCache();

export function resetExtractionCache(): void {
  extractionCache = emptyExtractionCache();
  warnedPropTargets.clear();
}

export function extractionCacheStats(): { programsCreated: number; sourceFilesParsed: number } {
  return {
    programsCreated: extractionCache.programsCreated,
    sourceFilesParsed: extractionCache.sourceFilesParsed,
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  return (
    "{" +
    Object.keys(value as object)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

function fileStamp(fileName: string): { mtimeMs: number; size: number } | undefined {
  try {
    const st = fs.statSync(fileName);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return undefined;
  }
}

// M57: a `.vue` script block has no file of its own. It is served to the
// program from memory under a `<sfc>.ts` name in the SFC's own directory, so
// relative imports, tsconfig `paths` and the checker resolve exactly as they do
// for a real file: and so `./Child.vue` resolves too, because TS's bundler
// resolution probes `./Child.vue.ts` for a specifier it cannot otherwise place.
// Never cached by stamp: virtual files have none, which is what keeps them fresh.
export interface VirtualScripts {
  has(fileName: string): boolean;
  read(fileName: string): string | undefined;
}

function createCachedProgram(
  rootFile: string,
  options: ts.CompilerOptions,
  virtual?: VirtualScripts,
  // M97: a JS entry's sibling declaration, so the declaration's own symbols
  // bind in the same program the entry is checked in.
  extraRoots?: string[],
): ts.Program {
  const optionsKey = stableStringify(options);
  const host = ts.createCompilerHost(options);

  if (virtual) {
    const baseFileExists = host.fileExists.bind(host);
    const baseReadFile = host.readFile.bind(host);
    host.fileExists = (fileName) => virtual.has(fileName) || baseFileExists(fileName);
    host.readFile = (fileName) =>
      virtual.has(fileName) ? virtual.read(fileName) : baseReadFile(fileName);
  }

  const baseGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
    if (virtual?.has(fileName)) {
      return ts.createSourceFile(
        fileName,
        virtual.read(fileName) ?? "",
        ts.ScriptTarget.Latest,
        true,
        fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
    }
    const caseKey = ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase();
    // Bucketed by options like the document registry: a source file bound
    // under one options set is never reused under another.
    const key = optionsKey + "|" + caseKey;
    const stamp = fileStamp(fileName);
    const cached = extractionCache.sourceFiles.get(key);
    if (
      cached &&
      stamp &&
      !shouldCreateNewSourceFile &&
      cached.mtimeMs === stamp.mtimeMs &&
      cached.size === stamp.size
    ) {
      return cached.sf;
    }
    const sf = baseGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
    if (sf && stamp) {
      extractionCache.sourceFiles.set(key, { sf, mtimeMs: stamp.mtimeMs, size: stamp.size });
      extractionCache.sourceFilesParsed++;
    }
    return sf;
  };

  const oldProgram =
    extractionCache.lastOptionsKey === optionsKey ? extractionCache.lastProgram : undefined;
  const roots = extraRoots?.length ? [rootFile, ...extraRoots] : [rootFile];
  const program = ts.createProgram(roots, options, host, oldProgram);
  extractionCache.lastProgram = program;
  extractionCache.lastOptionsKey = optionsKey;
  extractionCache.programsCreated++;
  return program;
}

// M84 cross-lane interface: how a schema's value(s) were chosen. Lane C (M85)
// keys a combo's `harnessFault` on this. "declared": a real literal or union
// member from the type. "preset": from a `<stem>.props.tsx` (set only by
// `applyPropPresets`, never assigned in this file). "heuristic": a name-based
// special case such as `currencyCode`. "placeholder": a generic, type-agnostic
// fill such as `"test"`. "contract": a value whose truthiness imposes a
// requirement on other props, such as `asChild`.
export type PropProvenance = "declared" | "preset" | "heuristic" | "placeholder" | "contract";

export interface PropSchema {
  name: string;
  kind:
    | "boolean"
    | "string"
    | "number"
    | "union"
    | "array"
    | "function"
    | "reactnode"
    | "object"
    | "unknown";
  required: boolean;
  values: unknown[];
  // Array props only: a value shaped like one element, synthesized from the
  // element type. Absent when the element type has no synthesizable shape.
  elementTemplate?: unknown;
  // M60: why the generated value is not a faithful stand-in for the declared
  // type. Set means the component is measured with something it cannot use.
  degenerate?: string;
  // M84: how the value(s) above were chosen. See `PropProvenance`.
  provenance?: PropProvenance;
  // M103 (I8, calcom-F2): the default the component itself declares, when it
  // is a literal the AST can read. Absent means no default was declared or the
  // declared one is not a literal — never "the default is undefined".
  defaultValue?: unknown;
  defaultSource?: "destructuring" | "withDefaults" | "defaultProps";
}

export interface ScalingPropMatch {
  schema: PropSchema;
  kind: "numeric" | "array";
  reason: string;
}

// M65: `target` overrides M58's selection order with the export the user named
// (`<file>#Export`); `onWarning` collects what extraction would have written to
// stderr, so a dry run can print the same diagnostics as data.
export interface ExtractPropsOptions {
  target?: string;
  onWarning?: (message: string) => void;
}

export interface PropsExtraction {
  schemas: PropSchema[];
  // The declaration the schema was bound to, and where it sits. Absent for a
  // Vue SFC, whose props come from a `defineProps` call rather than a component
  // declaration, and for a file with no component at all.
  targetName?: string;
  targetLine?: number;
  computedAnnotation?: string;
  warnings: string[];
}

const ITEMS_PATTERN = /items|options|data|children|entries|records|elements|list/i;
const SCALING_NAME_PATTERN = /count|size|length|limit|max|total|depth|level|columns|rows|pages/i;
const NUMERIC_SHORTHAND = /^n$|^num/i;
const ARIA_PATTERN = /^aria-/;
// M103 (base-ui-F3): a numeric prop whose name denotes a bound or a step is
// not a quantity of rendered things. `NumberFieldRoot.max` matched
// SCALING_NAME_PATTERN's `/max/i` and ran a whole curve mode whose own output
// then reported that the DOM node count never moved. Exact names only: a
// `maxItems` or `rowCount` still scales.
const SCALING_BOUND_NAME =
  /^(min|max|step|largeStep|smallStep|precision|decimalScale|tabIndex|zIndex|maxLength|minLength|maxWidth|minWidth|maxHeight|minHeight)$/i;

export function detectScalingProps(schemas: PropSchema[]): ScalingPropMatch[] {
  const matches: ScalingPropMatch[] = [];

  for (const schema of schemas) {
    if (ARIA_PATTERN.test(schema.name)) continue;
    if (schema.kind === "array" && ITEMS_PATTERN.test(schema.name)) {
      matches.push({ schema, kind: "array", reason: "array prop with items-like name" });
    } else if (schema.kind === "array") {
      matches.push({ schema, kind: "array", reason: "array prop" });
    } else if (schema.kind === "number" && SCALING_BOUND_NAME.test(schema.name)) {
      continue;
    } else if (schema.kind === "number" && SCALING_NAME_PATTERN.test(schema.name)) {
      matches.push({ schema, kind: "numeric", reason: "numeric prop name matches scaling pattern" });
    } else if (schema.kind === "number" && NUMERIC_SHORTHAND.test(schema.name)) {
      matches.push({ schema, kind: "numeric", reason: "numeric prop" });
    }
  }

  const priority: Record<string, number> = {
    "array prop with items-like name": 0,
    "array prop": 1,
    "numeric prop name matches scaling pattern": 2,
    "numeric prop": 3,
  };
  matches.sort((a, b) => priority[a.reason] - priority[b.reason]);

  return matches;
}

export async function extractProps(
  filePath: string,
  options?: ExtractPropsOptions,
): Promise<PropSchema[]> {
  return (await extractPropsDetailed(filePath, options)).schemas;
}

// M65: the same resolution `extractProps` performs, plus the binding facts a
// dry run has to show. `extractProps` is the schema-only view of it.
export async function extractPropsDetailed(
  filePath: string,
  options?: ExtractPropsOptions,
): Promise<PropsExtraction> {
  const absolutePath = path.resolve(filePath);
  const warnings: string[] = [];
  const sink = (message: string): void => {
    warnings.push(message.trimEnd());
    options?.onWarning?.(message);
  };
  const collecting = options?.onWarning !== undefined;

  if (isVueFile(absolutePath)) {
    const schemas = await extractVueProps(absolutePath, collecting ? sink : undefined);
    return { schemas, warnings };
  }

  const compilerOptions = createCompilerOptions(absolutePath);
  // M97 / ADR 0004: a JavaScript entry's declared types live in a sibling
  // `.d.ts`. It joins the program as a second root so its symbols bind.
  const declarationPath = isJsEntry(absolutePath)
    ? resolveEntryDeclaration(absolutePath, compilerOptions)
    : undefined;
  const program = createCachedProgram(
    absolutePath,
    compilerOptions,
    undefined,
    declarationPath ? [declarationPath] : undefined,
  );
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(absolutePath);

  if (!sourceFile) {
    throw new Error(`Could not parse ${filePath}`);
  }

  // M81 section 6: the classification loop's own try/catch (inside
  // `typeToSchema`) covers a recursion that surfaces per-prop; this outer
  // guard covers one that surfaces resolving the target's props type itself,
  // before or during that loop, so a self-referential generic never reaches
  // the CLI as a bare, unattributed crash.
  let binding: PropsBinding = {};
  let schemas: PropSchema[] = [];
  let recursed = false;
  try {
    binding = findComponentPropsType(
      sourceFile,
      checker,
      options?.target,
      collecting ? sink : undefined,
    );
    // M97 / ADR 0004: the sibling declaration is the published contract, so it
    // outranks `bindProps`'s last resort (the call signatures of the binding's
    // own type) and answers where the JavaScript source binds nothing at all.
    // The bound function is kept: its destructured names are what the
    // source-reference ranking reads.
    if (declarationPath && (binding.type === undefined || binding.viaTypeFallback)) {
      const declared = propsFromDeclaration(declarationPath, program, checker);
      if (declared) binding = { ...binding, type: declared };
    }
    if (binding.type === undefined && binding.unboundTargetHijacked && binding.targetName) {
      warnUnboundTarget(absolutePath, binding.targetName, collecting ? sink : undefined);
    }
    schemas = binding.type
      ? typeToSchema(binding.type, checker, absolutePath, collecting ? sink : undefined, binding.fn)
      : [];
    // M103 (I8): the component's own declared defaults, destructuring first —
    // it is the form a reader of the source sees.
    schemas = applyDeclaredDefaults(
      schemas,
      destructuredParameterDefaults(binding.fn),
      "destructuring",
    );
    if (binding.targetName) {
      schemas = applyDeclaredDefaults(
        schemas,
        defaultPropsAssignment(sourceFile, binding.targetName),
        "defaultProps",
      );
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    recursed = true;
    warnRecursiveType(
      absolutePath,
      binding.targetName ?? path.basename(absolutePath),
      collecting ? sink : undefined,
    );
  }

  if (!recursed && schemas.length === 0 && binding.computedAnnotation && binding.targetName) {
    warnUnenumerableProps(
      absolutePath,
      binding.targetName,
      binding.computedAnnotation,
      collecting ? sink : undefined,
    );
  }
  if (!recursed) {
    warnDegenerateProps(absolutePath, schemas, collecting ? sink : undefined);
  }
  // M97 / ADR 0004: an empty JS schema now names its own cause instead of
  // reaching analyze.ts's generic "extraction may have failed" hedge.
  if (
    !recursed &&
    schemas.length === 0 &&
    isJsEntry(absolutePath) &&
    binding.targetName !== undefined &&
    binding.computedAnnotation === undefined
  ) {
    warnUntypedJsComponent(absolutePath, binding.targetName, collecting ? sink : undefined);
  }

  return {
    schemas,
    ...(binding.targetName !== undefined ? { targetName: binding.targetName } : {}),
    ...(binding.targetLine !== undefined ? { targetLine: binding.targetLine } : {}),
    ...(binding.computedAnnotation !== undefined
      ? { computedAnnotation: binding.computedAnnotation }
      : {}),
    warnings,
  };
}

// --- M57: Vue single-file components -----------------------------------------

interface DefinePropsCall {
  typeNode?: ts.TypeNode;
  // The second argument of `withDefaults`, when the call is wrapped in one.
  defaults?: ts.ObjectLiteralExpression;
}

// `defineProps` is a compiler macro, so the identifier is always literal: no
// alias to follow. React's props type is a function *parameter* type; this one
// is a call's type argument, which is why the React finder cannot be reused.
export function findDefineProps(sourceFile: ts.SourceFile): DefinePropsCall | undefined {
  let found: DefinePropsCall | undefined;

  const isDefineProps = (node: ts.Node): node is ts.CallExpression =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "defineProps";

  const visit = (node: ts.Node): void => {
    if (found) return;

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "withDefaults" &&
      node.arguments.length > 0 &&
      isDefineProps(node.arguments[0])
    ) {
      const inner = node.arguments[0] as ts.CallExpression;
      const defaults = node.arguments[1];
      found = {
        ...(inner.typeArguments?.[0] ? { typeNode: inner.typeArguments[0] } : {}),
        ...(defaults && ts.isObjectLiteralExpression(defaults) ? { defaults } : {}),
      };
      return;
    }

    if (isDefineProps(node)) {
      found = { ...(node.typeArguments?.[0] ? { typeNode: node.typeArguments[0] } : {}) };
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

// A defaulted prop is the value the author says is normal, and every anchor in
// the pipeline reads `values[0]`: deltas, matrix baselines, curve anchors. So
// the default is moved to the front of the pool rather than transported through
// a second channel. Vue's array/object defaults are factory functions; their
// literal bodies are read the same way.
export function applyWithDefaults(
  schemas: PropSchema[],
  defaults: ts.ObjectLiteralExpression | undefined,
): PropSchema[] {
  if (!defaults) return schemas;

  const byName = new Map<string, unknown>();
  for (const property of defaults.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name =
      ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
        ? property.name.text
        : undefined;
    if (name === undefined) continue;

    let expression: ts.Expression = property.initializer;
    if (ts.isArrowFunction(expression) && !ts.isBlock(expression.body)) {
      expression = expression.body;
    }
    const literal = literalValue(expression);
    if (literal.ok) byName.set(name, literal.value);
  }
  if (byName.size === 0) return schemas;

  // M103 (I8): the value was already moved to the front of the pool; it is now
  // also named as the default it is.
  return applyDeclaredDefaults(schemas, byName, "withDefaults", true);
}

// Every `<x>.vue.ts` (or `.tsx`, when the block says so) in the tree resolves to
// the script block of `<x>.vue`, parsed on demand. One entry point serves the
// measured file and every `.vue` it imports.
function createVueScripts(compiler: VueSfcCompiler): VirtualScripts {
  const cache = new Map<string, string | undefined>();

  const scriptFor = (vuePath: string): SfcScript | undefined => {
    const source = ts.sys.readFile(vuePath);
    if (source === undefined) return undefined;
    return parseSfcScript(source, vuePath, compiler);
  };

  const resolve = (fileName: string): string | undefined => {
    const key = path.normalize(fileName);
    if (cache.has(key)) return cache.get(key);

    let content: string | undefined;
    const match = /^(.*\.vue)\.(ts|tsx)$/i.exec(key);
    if (match && fs.existsSync(match[1])) {
      const script = scriptFor(match[1]);
      // An SFC with no <script setup> is still a module the graph can import;
      // it just contributes no declarations.
      const wanted = virtualScriptPath(match[1], script?.lang ?? "ts");
      if (path.normalize(wanted) === key) content = script?.content ?? "";
    }
    cache.set(key, content);
    return content;
  };

  return {
    has: (fileName) => resolve(fileName) !== undefined,
    read: (fileName) => resolve(fileName),
  };
}

// M80 scope 2: names the excluded declaration form so the warning states what
// IS true (props exist, in a form ADR 0002 deliberately does not read)
// instead of implying extraction failed or the component is broken. Same
// arrow-function shape and call convention as UNCOMPOSED_SIBLINGS_WARNING
// (src/composition.ts): a pure `(args) => string`, pushed straight through
// `sink?.()`, not routed through `emit`/`warnOnce`'s stderr-dedup path.
const OPTIONS_API_WARNING_MARK = "Vue's Options API";

export const VUE_OPTIONS_API_PROPS_WARNING = (
  absolutePath: string,
  form: "props" | "extends" | "mixins",
): string =>
  `${absolutePath} declares props through ${OPTIONS_API_WARNING_MARK} ("${form}"), a runtime form ` +
  `ADR 0002 deliberately does not read: extraction did not fail and the component is not broken.` +
  presetRemedyClause(absolutePath);

// M98 (primevue-F1): the remedy half of every scope-exclusion warning. With
// the preset file already on disk, "Add Badge.props.tsx" told a user to create
// what the same run had just loaded and measured.
function presetRemedyClause(absolutePath: string): string {
  return detectPropPresets(absolutePath)
    ? ` ${presetFileName(absolutePath)} next to it already supplies the values measured.`
    : ` Add ${presetFileName(absolutePath)} next to it to supply typed values for measurement.`;
}

// Lets extractSchemas (src/analyze.ts) recognize this specific warning among
// everything else onWarning may report, without parsing prose or duplicating
// the message text.
export function isVueOptionsApiPropsWarning(message: string): boolean {
  return message.includes(OPTIONS_API_WARNING_MARK);
}

// M92 (element-plus-F3): the <script setup> sibling of the Options-API case
// above -- a runtime-object `defineProps({...})` call (element-plus's
// split-bar.vue shape) is also an ADR 0002 scope exclusion, not a possible
// extraction failure. Previously this shape produced no warning at all
// (extractVueProps returned [] silently), so analyze.ts's generic "No props
// extracted ... extraction may have failed" fallback fired instead and
// implied a malfunction for a deliberate decision. Same register as
// VUE_OPTIONS_API_PROPS_WARNING on purpose.
const RUNTIME_DEFINE_PROPS_WARNING_MARK = "a runtime defineProps({...}) call";

export const VUE_RUNTIME_DEFINE_PROPS_WARNING = (absolutePath: string): string =>
  `${absolutePath} declares props through ${RUNTIME_DEFINE_PROPS_WARNING_MARK}, a runtime form ADR ` +
  `0002 deliberately does not read: extraction did not fail and the component is not broken.` +
  presetRemedyClause(absolutePath) +
  " Switching to defineProps<T>() gets automatic extraction.";

export function isVueRuntimeDefinePropsWarning(message: string): boolean {
  return message.includes(RUNTIME_DEFINE_PROPS_WARNING_MARK);
}

// M98 (element-plus-F5): `defineComponent({ props: selectProps, setup(props, ...) })`
// is Vue's Composition API with a runtime props object. Calling it "Vue's
// Options API" named a mechanism the file does not use and pointed a user
// fixing it at the wrong pattern. Same scope-exclusion register as the two
// warnings above; the remedy is unchanged because it was already correct.
const SETUP_RUNTIME_PROPS_WARNING_MARK = "a runtime props object read by setup()";

export const VUE_SETUP_RUNTIME_PROPS_WARNING = (absolutePath: string): string =>
  `${absolutePath} declares props through ${SETUP_RUNTIME_PROPS_WARNING_MARK} (Vue's Composition ` +
  `API), a runtime form ADR 0002 deliberately does not read: extraction did not fail and the ` +
  `component is not broken.` +
  presetRemedyClause(absolutePath);

export function isVueSetupRuntimePropsWarning(message: string): boolean {
  return message.includes(SETUP_RUNTIME_PROPS_WARNING_MARK);
}

// M98 (nuxt-ui-F1): `defineProps<BadgeProps>()` on a name nothing in the
// program declares yields TypeScript's error type, which `looksLikePropsType`
// rejects -- and the rejection returned `[]` with no `sink?.()` call at all, so
// the only text a user saw was analyze.ts's generic "extraction may have
// failed". This is a resolution failure rather than an ADR 0002 scope
// exclusion, so it deliberately stays out of
// `isVuePropsScopeExclusionWarning`.
const UNRESOLVED_DEFINE_PROPS_MARK = "defineProps<T>() type argument";

export const VUE_UNRESOLVED_PROPS_TYPE_WARNING = (
  absolutePath: string,
  typeText: string,
): string =>
  `Warning: ${UNRESOLVED_DEFINE_PROPS_MARK} "${typeText}" in ${absolutePath} could not be resolved: ` +
  `nothing the SFC's script blocks declare or import provides it, so no props were extracted. ` +
  `Add ${presetFileName(absolutePath)} next to it to supply values for measurement.\n`;

export function isVueUnresolvedPropsTypeWarning(message: string): boolean {
  return message.includes(UNRESOLVED_DEFINE_PROPS_MARK);
}

// Either Vue scope exclusion ADR 0002 defines: Options-API props or a
// <script setup> runtime-object defineProps({...}) call. What analyze.ts
// checks to decide disclosureReason: "propsExcluded" for a Vue component that
// extracted zero props, so it never has to know the two forms apart.
export function isVuePropsScopeExclusionWarning(message: string): boolean {
  return (
    isVueOptionsApiPropsWarning(message) ||
    isVueRuntimeDefinePropsWarning(message) ||
    isVueSetupRuntimePropsWarning(message)
  );
}

// M97 / ADR 0004: a JavaScript entry that bound no props type and had no
// declaration file to read. material-ui-F1 is what silence here produced:
// `React.forwardRef`'s own `ref`/`key` were reported as the contract and every
// measured combo mounted with `{}`. Same register as the two Vue scope
// exclusions above -- a stated cause rather than the generic
// "extraction may have failed" hedge.
const UNTYPED_JS_COMPONENT_MARK = "declares no props type and has no declaration file beside it";

export const UNTYPED_JS_COMPONENT_WARNING = (
  absolutePath: string,
  targetName: string,
  hasPresets = false,
): string =>
  `Warning: ${targetName} in ${absolutePath} ${UNTYPED_JS_COMPONENT_MARK}: measuring with no props. ` +
  `A sibling <stem>.d.ts is read when one exists (ADR 0004); this JavaScript source has neither an ` +
  `annotated props parameter nor a declaration.` +
  (hasPresets ? "\n" : ` Add ${presetFileName(absolutePath)} next to it to supply values.\n`);

// Lets src/analyze.ts recognize this specific warning, so the generic
// ZERO_PROPS_WARNING does not stack on top of a cause already stated.
export function isUntypedJsComponentWarning(message: string): boolean {
  return message.includes(UNTYPED_JS_COMPONENT_MARK);
}

// Per ADR 0002 this stays TypeScript-only: the runtime object form
// (`defineProps({ label: String })`) carries no types and yields no schemas,
// exactly as an untyped React component does.
async function extractVueProps(
  absolutePath: string,
  sink?: (message: string) => void,
): Promise<PropSchema[]> {
  const compiler = await loadVueCompiler(path.dirname(absolutePath));
  if (!compiler) return [];

  const virtual = createVueScripts(compiler);
  const root = vueEntryScript(absolutePath, virtual);
  if (!root) return [];

  const program = createCachedProgram(root, createCompilerOptions(absolutePath), virtual);
  const sourceFile = program.getSourceFile(root);
  if (!sourceFile) return [];

  const call = findDefineProps(sourceFile);
  if (!call?.typeNode) {
    // M80 scope 2 / M92 (element-plus-F3): this branch is reached three ways
    // -- a `.vue` file with NO <script setup> at all (an empty virtual entry
    // parses to zero calls, `call` undefined), a <script setup> with no
    // `defineProps` call at all (genuinely propless, `call` also undefined),
    // and a <script setup> runtime `defineProps({...})` call (ADR 0002:26's
    // own Vue case, e.g. fixtures/vue-project/RuntimeProps.vue -- `call` IS
    // defined, just with no type argument). `call` being defined is exactly
    // what tells the third shape apart from the first two: only a real
    // `defineProps` call site can be a runtime-form exclusion to disclose.
    if (call) {
      sink?.(VUE_RUNTIME_DEFINE_PROPS_WARNING(absolutePath));
      return [];
    }
    const source = ts.sys.readFile(absolutePath);
    if (source !== undefined && parseSfcScript(source, absolutePath, compiler) === undefined) {
      const form = detectOptionsApiProps(source, absolutePath, compiler);
      // M98 (element-plus-F5): `props:` alongside `setup()` is the Composition
      // API's runtime form, and saying "Options API" for it named a mechanism
      // the file does not use.
      if (form === "setup-props") sink?.(VUE_SETUP_RUNTIME_PROPS_WARNING(absolutePath));
      else if (form) sink?.(VUE_OPTIONS_API_PROPS_WARNING(absolutePath, form));
    }
    return [];
  }

  const checker = program.getTypeChecker();
  const propsType = checker.getTypeFromTypeNode(call.typeNode);
  if (!looksLikePropsType(propsType, checker)) {
    // M98 (nuxt-ui-F1): the one zero-prop Vue path that used to say nothing.
    const unresolved = unresolvedPropsTypeText(call.typeNode, propsType);
    if (unresolved) sink?.(VUE_UNRESOLVED_PROPS_TYPE_WARNING(absolutePath, unresolved));
    return [];
  }

  // M98: the sink reaches `typeToSchema` here the way it already does on the
  // React path, so a Vue prop's collapsed-union, cap and recursion
  // disclosures land in the same warnings list every other extraction
  // warning does (element-plus-F3).
  const schemas = applyWithDefaults(
    typeToSchema(propsType, checker, absolutePath, sink),
    call.defaults,
  );
  warnDegenerateProps(absolutePath, schemas, sink);
  return schemas;
}

// M98: TypeScript's error type is `any`, and a props type that reaches this
// point as `any`/`unknown` resolved to nothing usable. That is what tells
// `defineProps<BadgeProps>()` on a missing declaration apart from a genuinely
// empty `defineProps<{}>()`, whose type is an object with no members: a fact
// rather than a failure, and one that keeps its existing silence. Checking for
// a symbol at the type name would not work — an `import type { X } from
// "#build/missing"` still creates a local alias symbol for `X`.
function unresolvedPropsTypeText(typeNode: ts.TypeNode, propsType: ts.Type): string | undefined {
  if (!(propsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) return undefined;
  return typeNode.getText();
}

// The virtual name the resolver actually serves for this SFC, or undefined when
// it has no <script setup> to serve.
function vueEntryScript(vuePath: string, virtual: VirtualScripts): string | undefined {
  for (const lang of ["ts", "tsx"]) {
    const candidate = virtualScriptPath(vuePath, lang);
    if (virtual.has(candidate)) return candidate;
  }
  return undefined;
}

// M58: one component declaration per entry, in source order, with the export
// facts that decide which of them the harness will actually render.
interface ComponentCandidate {
  name: string;
  declaration:
    | ts.FunctionDeclaration
    | ts.ClassDeclaration
    | ts.VariableDeclaration
    | ts.ArrowFunction
    | ts.FunctionExpression
    // `export default memo(Imported)`: the component is not declared here.
    | ts.ExportAssignment;
  exported: boolean;
  isDefault: boolean;
  // Names the module exports this declaration under, when they differ from the
  // local one (`export { Core as AliasWidget }`).
  aliases: string[];
}

// M97 / ADR 0004 ---------------------------------------------------------------

const JS_ENTRY_EXTENSION = /\.(js|jsx|mjs|cjs)$/i;

function isJsEntry(absolutePath: string): boolean {
  return JS_ENTRY_EXTENSION.test(absolutePath);
}

// The package.json whose `main`/`module`/`exports["."]` names this exact entry,
// searched upward a bounded number of levels. Only that package.json's
// `types`/`typings` describes this entry; a package.json further up (MUI's
// `packages/mui-material/package.json` relative to `src/Badge/Badge.js`)
// describes its own barrel and must not be read as this component's contract.
function declaringPackageTypes(absolutePath: string): string | undefined {
  let dir = path.dirname(absolutePath);
  for (let level = 0; level < 5; level++) {
    const manifestPath = path.join(dir, "package.json");
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
        const types = manifest.types ?? manifest.typings;
        const entry =
          manifest.main ??
          manifest.module ??
          (typeof manifest.exports === "object" && manifest.exports !== null
            ? (manifest.exports as Record<string, unknown>)["."]
            : undefined);
        if (typeof types !== "string" || typeof entry !== "string") return undefined;
        if (path.resolve(dir, entry) !== absolutePath) return undefined;
        const declaration = path.resolve(dir, types);
        return declaration.endsWith(".d.ts") && fs.existsSync(declaration) ? declaration : undefined;
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

// ADR 0004: the resolution every importer of `./<stem>` already performs.
// `ts.resolveModuleName` prefers a `.d.ts` over the `.js` beside it, which is
// exactly the ranking a consumer of the package type-checks against.
function resolveEntryDeclaration(
  absolutePath: string,
  options: ts.CompilerOptions,
): string | undefined {
  const stem = path.basename(absolutePath, path.extname(absolutePath));
  const resolved = ts.resolveModuleName(`./${stem}`, absolutePath, options, ts.sys).resolvedModule
    ?.resolvedFileName;
  if (resolved && resolved !== absolutePath && resolved.endsWith(".d.ts")) return resolved;
  return declaringPackageTypes(absolutePath);
}

// The declared component's props, read the way an importer reads them: the
// exported symbol's first call signature's first parameter.
function propsFromDeclaration(
  declarationPath: string,
  program: ts.Program,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  const declarationFile = program.getSourceFile(declarationPath);
  if (!declarationFile) return undefined;
  const moduleSymbol = checker.getSymbolAtLocation(declarationFile);
  if (!moduleSymbol) return undefined;

  const exports = checker.getExportsOfModule(moduleSymbol);
  const stem = normalizeComponentName(path.basename(declarationPath).replace(/\.d\.ts$/i, ""));
  const ranked = [
    exports.find((symbol) => symbol.getName() === "default"),
    exports.find((symbol) => normalizeComponentName(symbol.getName()) === stem),
    ...exports,
  ];

  for (const symbol of ranked) {
    if (!symbol) continue;
    const resolved =
      symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const location = resolved.getDeclarations()?.[0] ?? declarationFile;
    const type = checker.getTypeOfSymbolAtLocation(resolved, location);
    for (const signature of type.getCallSignatures()) {
      const parameter = signature.getParameters()[0];
      if (!parameter) continue;
      const parameterType = checker.getTypeOfSymbolAtLocation(parameter, location);
      if (looksLikePropsType(parameterType, checker)) return parameterType;
    }
  }
  return undefined;
}

interface BoundProps {
  type: ts.Type;
  // The function the type came from, when one was reachable: the source of
  // the destructured parameter names the self-consistency guard compares.
  fn?: ts.SignatureDeclaration;
  // M97: set only by the last resort in `bindProps` — the call signatures of
  // the binding's own type, rather than an annotated parameter. A JS entry's
  // sibling declaration outranks this one (ADR 0004).
  viaTypeFallback?: boolean;
}

const IDENTIFIER_HOPS = 8;

// M65: the one stem rule. Shared with `detectComponentExport` so the harness
// renders the component whose props were extracted.
export function normalizeComponentName(name: string): string {
  return name.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function collectComponentCandidates(sourceFile: ts.SourceFile): ComponentCandidate[] {
  const candidates: ComponentCandidate[] = [];
  const exportedNames = new Set<string>();
  const defaultNames = new Set<string>();
  const aliasesByLocal = new Map<string, string[]>();

  ts.forEachChild(sourceFile, (node) => {
    const exported = hasExportModifier(node);
    const isDefault = exported && hasDefaultModifier(node);

    if (ts.isFunctionDeclaration(node)) {
      if (node.name && isComponentName(node.name.text)) {
        candidates.push({
          name: node.name.text,
          declaration: node,
          exported,
          isDefault,
          aliases: [],
        });
      } else if (isDefault) {
        // export default function (props: Props): nameless but still the target.
        candidates.push({ name: "default", declaration: node, exported, isDefault, aliases: [] });
      }
      return;
    }

    if (ts.isClassDeclaration(node) && node.name && isComponentName(node.name.text)) {
      candidates.push({
        name: node.name.text,
        declaration: node,
        exported,
        isDefault,
        aliases: [],
      });
      return;
    }

    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !isComponentName(decl.name.text)) continue;
        candidates.push({
          name: decl.name.text,
          declaration: decl,
          exported,
          isDefault: false,
          aliases: [],
        });
      }
      return;
    }

    // export default Component;  /  export default memo(Component);
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const identifier = identifierBehind(node.expression);
      if (identifier) {
        exportedNames.add(identifier.text);
        defaultNames.add(identifier.text);
      }
      const fn = extractFunctionFromInitializer(node.expression);
      candidates.push({
        // A local declaration named by the assignment is pushed earlier and
        // wins selection; this entry carries files whose default export names
        // something declared elsewhere.
        name: identifier?.text ?? "default",
        declaration: fn ?? node,
        exported: true,
        isDefault: true,
        aliases: [],
      });
      return;
    }

    // export { A, B as default }
    if (ts.isExportDeclaration(node)) {
      if (node.isTypeOnly || !node.exportClause || !ts.isNamedExports(node.exportClause)) return;
      for (const spec of node.exportClause.elements) {
        if (spec.isTypeOnly) continue;
        const local = spec.propertyName?.text ?? spec.name.text;
        exportedNames.add(local);
        if (spec.name.text === "default") defaultNames.add(local);
        else if (spec.name.text !== local) {
          aliasesByLocal.set(local, [...(aliasesByLocal.get(local) ?? []), spec.name.text]);
        }
      }
    }
  });

  for (const candidate of candidates) {
    if (exportedNames.has(candidate.name)) candidate.exported = true;
    if (defaultNames.has(candidate.name)) candidate.isDefault = true;
    const aliases = aliasesByLocal.get(candidate.name);
    if (aliases) candidate.aliases = aliases;
  }

  return candidates;
}

// Selection order (M58): default export > file-stem match after dropping
// non-alphanumerics > first exported component > first declaration. The last
// step only applies to files that export nothing at all.
function selectTargetCandidate(
  candidates: ComponentCandidate[],
  fileName: string,
  sourceText: string,
  explicitTarget?: string,
): ComponentCandidate | undefined {
  // M65: `<file>#Export` names the component the harness will import, so the
  // schema follows it rather than the selection order. Aliases count: the name
  // the module exports under is the name the user can type.
  if (explicitTarget) {
    const named = candidates.find((c) =>
      [c.name, ...c.aliases].some((name) => name === explicitTarget),
    );
    if (named) return named;
  }

  const defaultExport = candidates.find((c) => c.isDefault);
  if (defaultExport) return defaultExport;

  const exported = candidates.filter((c) => c.exported);
  if (exported.length > 0) {
    const stem = normalizeComponentName(path.basename(fileName, path.extname(fileName)));
    const stemMatch = exported.find((c) =>
      [c.name, ...c.aliases].some((name) => normalizeComponentName(name) === stem),
    );
    if (stemMatch) return stemMatch;

    // M103 (heroui-F2): the header named `BadgeRoot` and the props table
    // described `BadgeAnchor`. `detectComponentExport` reads `scanExports`'s
    // order (heroui's `export { BadgeRoot, BadgeLabel, BadgeAnchor }`); this
    // function read declaration order, where BadgeAnchor comes first. One
    // selection function over one export list, so the two cannot diverge.
    const measured = selectMeasuredExport(scanExports(sourceText, fileName), fileName);
    const measuredMatch = measured
      ? exported.find((c) => [c.name, ...c.aliases].includes(measured))
      : undefined;
    return measuredMatch ?? exported[0];
  }

  return candidates[0];
}

// M103: the export a run measures, from one list of exports. `scanExports`
// lives in this file and `detectComponentExport` (src/harness.ts) already
// imports from here, so the harness's own pick can route through this same
// order (I9's `Provider` rule is the third clause).
export function selectMeasuredExport(
  exports: ExportInfo[],
  fileName: string,
  target?: string,
): string | undefined {
  if (target) return exports.find((e) => e.name === target)?.name;

  const defaultExport = exports.find((e) => e.isDefault);
  if (defaultExport) return defaultExport.name;

  const stem = normalizeComponentName(path.basename(fileName, path.extname(fileName)));
  const stemMatch = exports.find((e) => normalizeComponentName(e.name) === stem);
  if (stemMatch) return stemMatch.name;

  const uncontrolled = exports.find((e) => !PROVIDER_EXPORT_SUFFIX.test(e.name));
  if (uncontrolled) return uncontrolled.name;

  return exports[0]?.name;
}

const PROVIDER_EXPORT_SUFFIX = /Provider$/;

// `memo(Inner)` / `forwardRef(Inner)` / `Inner`: the identifier a wrapper chain
// ultimately names, when it names one.
function identifierBehind(expression: ts.Expression): ts.Identifier | undefined {
  if (ts.isIdentifier(expression)) return expression;
  if (ts.isCallExpression(expression) && expression.arguments.length > 0) {
    return identifierBehind(expression.arguments[0]);
  }
  return undefined;
}

function propsFromParameter(
  fn: ts.SignatureDeclaration,
  checker: ts.TypeChecker,
): BoundProps | undefined {
  const param = fn.parameters[0];
  if (!param) return undefined;
  const type = checker.getTypeAtLocation(param);
  return looksLikePropsType(type, checker) ? { type, fn } : undefined;
}

function bindProps(
  candidate: ComponentCandidate,
  checker: ts.TypeChecker,
  byName: Map<string, ComponentCandidate>,
  hops = 0,
): BoundProps | undefined {
  const declaration = candidate.declaration;

  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isArrowFunction(declaration) ||
    ts.isFunctionExpression(declaration)
  ) {
    return propsFromParameter(declaration, checker);
  }

  // class Counter extends React.Component<Props>
  if (ts.isClassDeclaration(declaration)) {
    for (const clause of declaration.heritageClauses ?? []) {
      for (const typeExpr of clause.types) {
        const typeArgs = typeExpr.typeArguments;
        if (!typeArgs || typeArgs.length === 0) continue;
        const type = checker.getTypeFromTypeNode(typeArgs[0]);
        if (looksLikePropsType(type, checker)) return { type };
      }
    }
    return undefined;
  }

  const expression = ts.isExportAssignment(declaration)
    ? declaration.expression
    : declaration.initializer;
  if (!expression) return undefined;

  // const Component = (props: Props) => ... / memo(forwardRef((props, ref) => ...))
  const fn = extractFunctionFromInitializer(expression);
  if (fn) {
    const bound = propsFromParameter(fn, checker);
    if (bound) return bound;
  }

  // const Component = memo(Inner): follow the identifier to its declaration.
  if (!fn && hops < IDENTIFIER_HOPS) {
    const identifier = identifierBehind(expression);
    const referenced = identifier ? byName.get(identifier.text) : undefined;
    if (referenced && referenced !== candidate) {
      const bound = bindProps(referenced, checker, byName, hops + 1);
      if (bound) return bound;
    }
  }

  // const Component: FC<Props> = <anything callable>, or a default export whose
  // component was declared in another module.
  const type = checker.getTypeAtLocation(
    ts.isExportAssignment(declaration) ? expression : declaration.name,
  );
  for (const signature of type.getCallSignatures()) {
    const param = signature.getParameters()[0];
    if (!param) continue;
    const paramType = checker.getTypeOfSymbolAtLocation(param, declaration);
    if (looksLikePropsType(paramType, checker)) {
      return { type: paramType, viaTypeFallback: true };
    }
  }

  return undefined;
}

// M103 (I8, calcom-F2): the literal defaults a destructured first parameter
// declares (`{ loading = false, color = "primary" }`). A non-literal default
// (a call, a variable) is not recorded rather than guessed at.
function destructuredParameterDefaults(
  fn: ts.SignatureDeclaration | undefined,
): Map<string, unknown> {
  const defaults = new Map<string, unknown>();
  const collect = (pattern: ts.ObjectBindingPattern): void => {
    for (const element of pattern.elements) {
      if (element.dotDotDotToken || !element.initializer) continue;
      const source = element.propertyName ?? element.name;
      if (!ts.isIdentifier(source) && !ts.isStringLiteral(source)) continue;
      const literal = literalValue(element.initializer);
      if (literal.ok) defaults.set(source.text, literal.value);
    }
  };

  const param = fn?.parameters[0];
  if (!param) return defaults;
  if (ts.isObjectBindingPattern(param.name)) collect(param.name);

  // calcom's Button destructures in the body, not in the parameter list
  // (`function Button(props) { const { loading = false, ... } = props; }`), the
  // same shape `sourceReferencedPropNames` already walks for.
  const body = fn && "body" in fn ? fn.body : undefined;
  if (!body || !ts.isIdentifier(param.name)) return defaults;
  const paramName = param.name.text;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      node.initializer.text === paramName
    ) {
      collect(node.name);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return defaults;
}

// M103 (I8): the pre-hooks convention, `Component.defaultProps = {...}` at the
// top level of the component's own file. Parse-only, same shallow tradeoff
// `detectOptionsApiProps` accepts.
function defaultPropsAssignment(
  sourceFile: ts.SourceFile,
  targetName: string,
): Map<string, unknown> {
  const defaults = new Map<string, unknown>();
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement)) continue;
    const expression = statement.expression;
    if (!ts.isBinaryExpression(expression)) continue;
    if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    const left = expression.left;
    if (!ts.isPropertyAccessExpression(left)) continue;
    if (left.name.text !== "defaultProps") continue;
    if (!ts.isIdentifier(left.expression) || left.expression.text !== targetName) continue;
    if (!ts.isObjectLiteralExpression(expression.right)) continue;
    for (const property of expression.right.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = property.name;
      if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) continue;
      const literal = literalValue(property.initializer);
      if (literal.ok) defaults.set(name.text, literal.value);
    }
  }
  return defaults;
}

// M103 (I8): the default is recorded on the schema. `reorderValues` is Vue's
// pre-M103 `withDefaults` behavior (the declared default leads the pool) and
// stays exactly where it was; a React default is disclosed without changing
// which values are measured in which order, since M103 changes ranking,
// binding and typing only.
function applyDeclaredDefaults(
  schemas: PropSchema[],
  defaults: Map<string, unknown>,
  source: NonNullable<PropSchema["defaultSource"]>,
  reorderValues = false,
): PropSchema[] {
  if (defaults.size === 0) return schemas;
  return schemas.map((schema) => {
    if (!defaults.has(schema.name)) return schema;
    const value = defaults.get(schema.name);
    const values = reorderValues
      ? [value, ...schema.values.filter((v) => !Object.is(v, value))]
      : schema.values;
    return { ...schema, values, defaultValue: value, defaultSource: source };
  });
}

// Names bound out of a destructured first parameter, renames resolved to the
// source property and rest elements ignored.
function destructuredParameterNames(fn: ts.SignatureDeclaration | undefined): string[] {
  const param = fn?.parameters[0];
  if (!param || !ts.isObjectBindingPattern(param.name)) return [];
  const names: string[] = [];
  for (const element of param.name.elements) {
    if (element.dotDotDotToken) continue;
    const source = element.propertyName ?? element.name;
    if (ts.isIdentifier(source) || ts.isStringLiteral(source)) names.push(source.text);
  }
  return names;
}

function overlapsDestructuring(bound: BoundProps, names: string[]): boolean {
  const keys = new Set(bound.type.getProperties().map((p) => p.getName()));
  return names.some((name) => keys.has(name));
}

// M86 MUST 1: a prop the component's own source references by name outranks
// an inherited prop it does not — a source-TEXT signal, not a type-flow one.
// ant-design's Button calls `props.onClick?.(...)` (Button.tsx:294) and wires
// `onClick={handleClick}` while `onClick`'s type is purely inherited through
// `MergedHTMLAttributes` with no local redeclaration; M81's tiers only ever
// look at where a prop's TYPE is declared, so they cannot see this. Walks the
// bound function's own body once for `<param>.name` member access and any
// local `const { name } = <param>` destructuring, in addition to the
// destructured-parameter names `destructuredParameterNames` already finds.
function sourceReferencedPropNames(fn: ts.SignatureDeclaration | undefined): Set<string> {
  const names = new Set(destructuredParameterNames(fn));
  const param = fn?.parameters[0];
  const body = fn && "body" in fn ? fn.body : undefined;
  if (!param || !body || !ts.isIdentifier(param.name)) return names;
  const paramName = param.name.text;

  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === paramName
    ) {
      names.add(node.name.text);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      node.initializer.text === paramName
    ) {
      for (const element of node.name.elements) {
        if (element.dotDotDotToken) continue;
        const source = element.propertyName ?? element.name;
        if (ts.isIdentifier(source) || ts.isStringLiteral(source)) names.add(source.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return names;
}

// Whether the target declares a parameter at all. A component that takes none
// has no props to miss, so its empty schema is an answer rather than a failure.
function expectsProps(candidate: ComponentCandidate): boolean {
  const declaration = candidate.declaration;
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isArrowFunction(declaration) ||
    ts.isFunctionExpression(declaration)
  ) {
    return declaration.parameters.length > 0;
  }
  if (ts.isClassDeclaration(declaration)) return true;
  const expression = ts.isExportAssignment(declaration)
    ? declaration.expression
    : declaration.initializer;
  if (!expression) return false;
  const fn = extractFunctionFromInitializer(expression);
  // An initializer that is not a function literal (an alias, a factory call)
  // may still be a component; its parameter list is not visible here.
  return fn ? fn.parameters.length > 0 : true;
}

// One warning per target per process (mirrors the tsconfig warning policy).
const warnedPropTargets = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedPropTargets.has(key)) return;
  warnedPropTargets.add(key);
  process.stderr.write(message);
}

// A sink replaces the stderr write entirely: a dry run collects the same text
// as data, and the once-per-process dedupe must not hide it from the second
// caller that asks.
function emit(key: string, message: string, sink?: (message: string) => void): void {
  if (sink) {
    sink(message);
    return;
  }
  warnOnce(key, message);
}

function warnUnboundTarget(
  fileName: string,
  targetName: string,
  sink?: (message: string) => void,
): void {
  emit(
    `${path.resolve(fileName)}::${targetName}`,
    `Warning: could not resolve props for ${targetName} in ${fileName}: measuring with no props. ` +
      `Another declaration in this file has props, but it is not the component being measured.\n`,
    sink,
  );
}

// The M44 escape hatch, named for the file at hand so the message is a command.
function presetFileName(fileName: string): string {
  const base = path.basename(fileName);
  const ext = path.extname(base);
  return `${ext ? base.slice(0, -ext.length) : base}.props.tsx`;
}

function warnPropCap(fileName: string, total: number): void {
  warnOnce(
    `${path.resolve(fileName)}::cap`,
    `Warning: ${total} props were extracted from ${fileName}; measuring the first ${MAX_PROPS}. ` +
      `Add ${presetFileName(fileName)} to choose the props that matter.\n`,
  );
}

// M84: a union with more than one non-undefined member collapses to one
// representative kind/value; a user reading only the schema cannot see what
// the other branches were. Names every branch's printed type and which kind
// the prop was measured as.
function warnCollapsedUnion(
  fileName: string,
  propName: string,
  branches: string[],
  chosenKind: string,
  sink?: (message: string) => void,
): void {
  emit(
    `${path.resolve(fileName)}::union::${propName}`,
    `Warning: prop "${propName}" in ${fileName} is a union of ${branches.length} different shapes ` +
      `(${branches.join(" | ")}); measured as ${chosenKind}. Add ${presetFileName(fileName)} to choose ` +
      `a different branch.\n`,
    sink,
  );
}

// M60: the props the component is measured with are not the props it declares.
// Silence here is what let four dogfooded projects report timings for renders
// that never received usable data.
function warnDegenerateProps(
  fileName: string,
  schemas: PropSchema[],
  sink?: (message: string) => void,
): void {
  const degenerate = schemas.filter((s) => s.degenerate);
  if (degenerate.length === 0) return;
  // The warning's whole content is "supply values yourself". A user who already
  // has is not told again.
  if (detectPropPresets(fileName)) return;
  const named = degenerate.map((s) => `${s.name} (${s.degenerate})`).join(", ");
  emit(
    `${path.resolve(fileName)}::degenerate::${degenerate.map((s) => s.name).join(",")}`,
    `Warning: no representative value could be synthesized for ${named} in ${fileName}. ` +
      `Add ${presetFileName(fileName)} next to it to supply real values.\n`,
    sink,
  );
}

function warnUnenumerableProps(
  fileName: string,
  targetName: string,
  annotation: string,
  sink?: (message: string) => void,
): void {
  emit(
    `${path.resolve(fileName)}::computed::${targetName}`,
    `Warning: props type ${annotation} for ${targetName} in ${fileName} could not be enumerated: ` +
      `measuring with no props. Add ${presetFileName(fileName)} to supply values.\n`,
    sink,
  );
}

// M81 section 6: a self-referential generic member can make a single checker
// call recurse arbitrarily deep inside TypeScript's own instantiation
// machinery. Named and excluded, the same register as an unenumerable
// computed type, instead of a bare "Maximum call stack size exceeded"
// reaching the CLI's top-level handler with no attribution.
function warnRecursiveProp(
  fileName: string,
  propName: string,
  sink?: (message: string) => void,
): void {
  emit(
    `${path.resolve(fileName)}::recursive::${propName}`,
    `Warning: prop "${propName}" in ${fileName} could not be classified: TypeScript's type resolution ` +
      `recursed too deeply -- likely a self-referential generic type. Excluded from the schema.\n`,
    sink,
  );
}

function warnRecursiveType(
  fileName: string,
  targetName: string,
  sink?: (message: string) => void,
): void {
  emit(
    `${path.resolve(fileName)}::recursive-type::${targetName}`,
    `Warning: props could not be resolved for ${targetName} in ${fileName}: TypeScript's type resolution ` +
      `recursed too deeply -- likely a self-referential generic type.\n`,
    sink,
  );
}

function warnUntypedJsComponent(
  fileName: string,
  targetName: string,
  sink?: (message: string) => void,
): void {
  emit(
    `${path.resolve(fileName)}::untyped-js::${targetName}`,
    UNTYPED_JS_COMPONENT_WARNING(fileName, targetName, detectPropPresets(fileName) !== undefined),
    sink,
  );
}

interface PropsBinding {
  type?: ts.Type;
  targetName?: string;
  // 1-based source line of the target's declaration.
  targetLine?: number;
  // The target's first-parameter annotation, when it is a computed type: the
  // only case where an empty schema is a resolution failure rather than a fact.
  computedAnnotation?: string;
  // M86: the function the props type was bound to, when one was reachable —
  // threaded through so `typeToSchema` can read which prop names the
  // component's own body references by name.
  fn?: ts.SignatureDeclaration;
  // M97: the type came from the binding's own call signatures, the last resort
  // in `bindProps`. A JS entry's sibling declaration outranks it (ADR 0004).
  viaTypeFallback?: boolean;
  // M97: nothing bound to the measured target while another declaration in the
  // same file did bind. Reported only once the declaration fallback has also
  // come up empty.
  unboundTargetHijacked?: boolean;
}

// A type reference with arguments (`ComponentProps<typeof X>`,
// `VariantProps<typeof x>`), a `typeof`/indexed access, or a composition of
// them. A plain `interface Props` that yields nothing yields nothing honestly.
function computedAnnotationText(node: ts.TypeNode | undefined): string | undefined {
  if (!node) return undefined;
  const isComputed = (n: ts.TypeNode): boolean => {
    if (ts.isTypeReferenceNode(n)) return (n.typeArguments?.length ?? 0) > 0;
    if (ts.isTypeQueryNode(n) || ts.isIndexedAccessTypeNode(n)) return true;
    if (ts.isIntersectionTypeNode(n) || ts.isUnionTypeNode(n)) return n.types.some(isComputed);
    if (ts.isParenthesizedTypeNode(n)) return isComputed(n.type);
    return false;
  };
  return isComputed(node) ? node.getText() : undefined;
}

// The `export`-inclusive start of the declaration, 1-based, so a dry run can
// point at the line a reader would open.
function declarationLine(sourceFile: ts.SourceFile, node: ts.Node): number | undefined {
  const statement =
    ts.isVariableDeclaration(node) && node.parent?.parent ? node.parent.parent : node;
  try {
    return sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1;
  } catch {
    return undefined;
  }
}

function firstParameterTypeNode(
  candidate: ComponentCandidate,
): ts.TypeNode | undefined {
  const declaration = candidate.declaration;
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isArrowFunction(declaration) ||
    ts.isFunctionExpression(declaration)
  ) {
    return declaration.parameters[0]?.type;
  }
  if (ts.isClassDeclaration(declaration)) return undefined;
  const expression = ts.isExportAssignment(declaration)
    ? declaration.expression
    : declaration.initializer;
  if (!expression) return undefined;
  return extractFunctionFromInitializer(expression)?.parameters[0]?.type;
}

function findComponentPropsType(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  explicitTarget?: string,
  sink?: (message: string) => void,
): PropsBinding {
  const candidates = collectComponentCandidates(sourceFile);
  const target = selectTargetCandidate(
    candidates,
    sourceFile.fileName,
    sourceFile.getFullText(),
    explicitTarget,
  );
  if (!target) return {};

  const byName = new Map<string, ComponentCandidate>();
  for (const candidate of candidates) {
    if (!byName.has(candidate.name)) byName.set(candidate.name, candidate);
  }

  let bound = bindProps(target, checker, byName);

  // Self-consistency: a props type that shares no key with what the target
  // destructures did not come from the target. Prefer one that does.
  const destructured = destructuredParameterNames(
    bound?.fn ??
      (ts.isFunctionDeclaration(target.declaration) ? target.declaration : undefined),
  );
  if (bound && destructured.length > 0 && !overlapsDestructuring(bound, destructured)) {
    for (const candidate of candidates) {
      if (candidate === target) continue;
      const other = bindProps(candidate, checker, byName);
      if (other && overlapsDestructuring(other, destructured)) {
        bound = other;
        break;
      }
    }
  }

  const computedAnnotation = computedAnnotationText(firstParameterTypeNode(target));
  const context = {
    targetName: target.name,
    targetLine: declarationLine(sourceFile, target.declaration),
    ...(computedAnnotation ? { computedAnnotation } : {}),
  };

  if (bound) {
    return {
      type: bound.type,
      fn: bound.fn,
      ...(bound.viaTypeFallback ? { viaTypeFallback: true } : {}),
      ...context,
    };
  }

  // M97: reported by the caller, after the sibling declaration has had its
  // turn. Emitting here claimed "could not resolve props" on every MUI `.js`
  // component whose declaration then resolved all sixteen.
  if (expectsProps(target)) {
    const hijacker = candidates.some(
      (candidate) => candidate !== target && bindProps(candidate, checker, byName),
    );
    if (hijacker) return { ...context, unboundTargetHijacked: true };
  }

  return context;
}

// M92 (M86's own motivating case, ant-design Button.tsx:294): a same-file,
// top-level `const NAME = <expr>` initializer for the given identifier --
// shallow and parse-only, matching this codebase's existing precedent for a
// same-file, top-level alias lookup (no cross-file/scope resolution, no
// checker). `identifier` names could theoretically collide across nested
// scopes; only a top-level match is trusted, the same tradeoff
// `detectOptionsApiProps`/`scanRelativeTypeImports` already accept elsewhere.
function findTopLevelVariableInitializer(identifier: ts.Identifier): ts.Expression | undefined {
  for (const statement of identifier.getSourceFile().statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === identifier.text && decl.initializer) {
        return decl.initializer;
      }
    }
  }
  return undefined;
}

function extractFunctionFromInitializer(
  node: ts.Expression,
  depth = 0,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  // M92: an `as`/`satisfies` assertion is erased at runtime and asserts
  // nothing about the VALUE, only a claim about its type -- ant-design's
  // `const Button = InternalCompoundedButton as CompoundedComponent` is
  // exactly InternalCompoundedButton at runtime. Unwrapped before every other
  // check, so it composes with the HOC-chain and identifier-alias cases below
  // regardless of where the assertion sits.
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) {
    return extractFunctionFromInitializer(node.expression, depth);
  }

  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return node;
  }

  // Recursively unwrap HOC chains: memo(forwardRef((props, ref) => ...))
  if (ts.isCallExpression(node)) {
    const args = node.arguments;
    if (args.length > 0) {
      return extractFunctionFromInitializer(args[0], depth);
    }
  }

  // M92: a bare identifier alias points at a different declaration, often in
  // the same file (ant-design's Button.tsx:294 own motivating shape) --
  // follow it once so Tier-0's source-reference scan (sourceReferencedPropNames)
  // sees the real implementation's body instead of an empty alias with none
  // of its own. Depth-bounded against a pathological `const A = B; const B
  // = A;` cycle; five hops is far more than any real alias chain needs.
  if (ts.isIdentifier(node) && depth < 5) {
    const target = findTopLevelVariableInitializer(node);
    if (target) return extractFunctionFromInitializer(target, depth + 1);
  }

  return undefined;
}

// M97 / ADR 0004: `React.forwardRef<T, P = {}>` with an unannotated render
// parameter types the binding as `ForwardRefExoticComponent<RefAttributes<any>>`,
// whose first call signature's parameter has exactly two properties: `ref` from
// `RefAttributes` and `key` from `Attributes`. Neither is a prop of the
// component. Origin matters as much as the name: a component that declares its
// own `ref` prop in its own file keeps it, because that declaration does not
// live in React's type packages.
const REACT_AMBIENT_ATTRIBUTES = new Set(["ref", "key"]);

function isReactAmbientAttribute(symbol: ts.Symbol): boolean {
  if (!REACT_AMBIENT_ATTRIBUTES.has(symbol.getName())) return false;
  const declarations = symbol.getDeclarations();
  if (!declarations || declarations.length === 0) return true;
  return declarations.every((declaration) =>
    REACT_TYPE_PACKAGE.test(declaration.getSourceFile().fileName),
  );
}

function looksLikePropsType(type: ts.Type, checker: ts.TypeChecker): boolean {
  const props = type.getProperties();
  if (props.length === 0) return false;
  if (props.every(isReactAmbientAttribute)) return false;

  const typeStr = checker.typeToString(type);
  if (["string", "number", "boolean", "undefined", "null"].includes(typeStr)) {
    return false;
  }

  if (type.isUnion() && type.types.every((t) =>
    !!(t.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral | ts.TypeFlags.Undefined | ts.TypeFlags.Null))
  )) {
    return false;
  }

  return true;
}

// TypeScript's own libs and React's type packages: between them they declare
// the ~300 DOM/ARIA members every `ComponentProps` drags in. A property
// declared anywhere else in node_modules is a design-system prop and is kept.
const DEFAULT_LIB_FILE = /[\\/]lib\.[^\\/]*\.d\.ts$/i;
const REACT_TYPE_PACKAGE = /[\\/]node_modules[\\/](@types[\\/])?react(-dom)?[\\/]/i;
const NODE_MODULES = /[\\/]node_modules[\\/]/;
const NOISE_PROP_NAME = /^(aria-|data-)/;

// M60: past this the props type is a DOM surface that slipped the filter, not a
// component's own contract.
const MAX_PROPS = 32;

function isDefaultLibFile(fileName: string): boolean {
  return DEFAULT_LIB_FILE.test(fileName);
}

function isAmbientNoiseDeclaration(decl: ts.Declaration): boolean {
  const fileName = decl.getSourceFile().fileName;
  return isDefaultLibFile(fileName) || REACT_TYPE_PACKAGE.test(fileName);
}

function isLocalDeclaration(decl: ts.Declaration): boolean {
  return !NODE_MODULES.test(decl.getSourceFile().fileName);
}

// M81: `isNoiseProp` still fully filters ambient (default-lib/@types-react)
// declarations for NESTED object-value synthesis (`synthesizeValue`), where an
// unbounded width would balloon a synthesized object with ~300 DOM/ARIA
// members no one asked for. The top-level prop schema no longer uses it: an
// ambient declaration site does not mean the member is noise (`onClick`,
// `disabled`, `children` are declared there exactly like `aria-activedescendant`
// is), so `typeToSchema` only applies the hard, silent `aria-`/`data-` filter
// and ranks everything else instead of erasing it pre-cap.
function isNoiseName(name: string): boolean {
  return NOISE_PROP_NAME.test(name);
}

function isNoiseProp(prop: ts.Symbol): boolean {
  if (isNoiseName(prop.getName())) return true;
  const decls = prop.getDeclarations();
  if (!decls || decls.length === 0) return false;
  return decls.every(isAmbientNoiseDeclaration);
}

// M81 section 1: a prop named `/^on[A-Z]/` whose type carries a call
// signature (an event handler), or named exactly `children`, is locally
// meaningful regardless of where it is declared.
const EVENT_HANDLER_NAME = /^on[A-Z]/;

// Non-`undefined`/`null`/`void` members of a (possibly union) type: the same
// filter `classifyType` applies before its own literal-union/boolean tests.
function nonUndefinedMembers(type: ts.Type): ts.Type[] {
  return type.isUnion()
    ? type.types.filter(
        (t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)),
      )
    : [type];
}

// M86: props the cap must never rank away — the target's own source
// referenced them by name, or a `<stem>.props.tsx` preset names them. Both
// are read once per extraction and merged into one promoted-name set;
// `propRank` checks it before any type-shape test.
function presetPropNames(fileName: string): Set<string> {
  const presetPath = detectPropPresets(fileName);
  if (!presetPath) return new Set();
  const presets = loadPropPresets(presetPath, path.dirname(presetPath));
  return presets ? new Set(presets.entries.keys()) : new Set();
}

// M81 section 1 (M86 adds Tier 0): four-tier rank computed over the props the
// cap has to choose among, stable within each tier.
// Tier 0 - promoted: the target's own source references this name, or a
//          preset names it. Neither signal depends on how the prop's TYPE
//          resolves, so an unresolved generic parameter cannot defeat it.
// Tier 1 - variant surface: a plain boolean or finite literal union on the
//          prop's own type - reuses the same cheap type-flag tests
//          `classifyType` uses later, so it is affordable to run over every
//          kept prop, not just the 32 survivors.
// Tier 2 - locally meaningful: `declaredHere` today, a computed/mapped-type
//          member with zero declarations (there is no declaration site to be
//          third-party at), or an event-handler/`children` name reached only
//          through an ambient declaration.
// Tier 3 - everything else: declared exclusively in node_modules, not
//          variant-shaped - today's tail behavior, unchanged.
// M103 (chakra-ui-F1, heroui-F3, dub-F7): origin decides before shape. M81's
// Tier 1 was shape only, so an inherited `translate?: "yes" | "no"` and an
// inherited `hidden?: boolean` outranked every prop the component itself
// declares whose type resolves to something less tidy -- chakra's Badge
// measured 32 props of which none were Badge's. See the rank table in
// specs/milestones/m103-the-measured-props-are-the-components-own.md.
type PropRank = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

// M103: how many members the interface or type literal that declares a prop
// declares. A component's own props interface is small (heroui's
// `BadgeRootProps` has six members); a DOM attribute surface
// (`HTMLAttributes`, ~250) and a style system's generated CSS-property surface
// (chakra's `SystemProperties`, ~300) are not. "Declared in the project's own
// sources" alone does not separate chakra's three recipe props from the three
// hundred style props declared beside them in the same package; width does.
const WIDE_DECLARATION_MEMBERS = 40;

function isNarrowDeclarationSite(decl: ts.Declaration): boolean {
  const parent = decl.parent;
  if (!parent) return true;
  if (ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent)) {
    return parent.members.length < WIDE_DECLARATION_MEMBERS;
  }
  if (ts.isTypeLiteralNode(parent)) return parent.members.length < WIDE_DECLARATION_MEMBERS;
  return true;
}

function propRank(
  prop: ts.Symbol,
  checker: ts.TypeChecker,
  promotedNames: Set<string>,
): PropRank {
  const name = prop.getName();
  if (promotedNames.has(name)) return 0;

  const decls = prop.getDeclarations();
  const decl = decls?.[0];
  const type = decl ? checker.getTypeOfSymbolAtLocation(prop, decl) : checker.getTypeOfSymbol(prop);
  const nonUndefined = nonUndefinedMembers(type);
  const target = nonUndefined.length === 1 ? nonUndefined[0] : type;

  const isVariantSurface =
    !!(target.flags & ts.TypeFlags.BooleanLike) ||
    isBooleanUnion(nonUndefined) ||
    (nonUndefined.length > 1 &&
      nonUndefined.every((m) => m.isStringLiteral() || !!(m.flags & ts.TypeFlags.StringLiteral))) ||
    (nonUndefined.length > 1 &&
      nonUndefined.every((m) => m.isNumberLiteral() || !!(m.flags & ts.TypeFlags.NumberLiteral)));

  // Declared in the project's own sources: the component's file, a local type
  // alias, or the package's generated recipe/variant types. A narrow
  // declaration site is the component's own surface; a wide one is a bulk
  // style/attribute surface that happens to live in the same package.
  if (decls && decls.length > 0 && decls.some(isLocalDeclaration)) {
    const narrow = decls.some((d) => isLocalDeclaration(d) && isNarrowDeclarationSite(d));
    if (narrow) return isVariantSurface ? 1 : 2;
    return isVariantSurface ? 4 : 5;
  }

  // A mapped or computed member has no declaration site to be third-party at,
  // and it is exactly the shape `RecipeProps<"badge">`/`VariantProps<typeof x>`
  // produce.
  if (!decls || decls.length === 0) return 3;

  if (isVariantSurface) return 6;

  // M86 mechanism 1: an unresolved generic parameter can make
  // `getCallSignatures()` report zero for a genuinely callable type (a
  // handler prop typed through `IntrinsicElements[E]`-style indirection with
  // `E` unbound). Extensive probing against polymorphic-element and
  // conditional-type shapes did not reproduce a real function type losing its
  // call signatures this way — see `m86-prop-selection-keeps-what-matters.md`
  // `## open` — but the failure signature such a defeat would most plausibly
  // produce (the type resolving to `any`/`unknown` rather than a concrete
  // non-callable type) is cheap and low-risk to also promote: a
  // deliberately-non-function prop named `/^on[A-Z]/` resolves to a concrete
  // type, not `any`/`unknown`.
  const isHandlerOrChildren =
    name === "children" ||
    (EVENT_HANDLER_NAME.test(name) &&
      (nonUndefined.some((t) => t.getCallSignatures().length > 0) ||
        nonUndefined.some((t) => t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))));
  if (isHandlerOrChildren) return 7;

  return 8;
}

function typeToSchema(
  type: ts.Type,
  checker: ts.TypeChecker,
  fileName?: string,
  sink?: (message: string) => void,
  fn?: ts.SignatureDeclaration,
): PropSchema[] {
  const kept = type.getProperties().filter((prop) => !isNoiseName(prop.getName()));

  // M86: required props are never dropped by the cap — a missing required
  // prop is not a degraded test case, it is a guaranteed crash (shadcn's
  // `chart.tsx` loses its required `config: ChartConfig` this way today).
  // They bypass ranking entirely; only the optional pool is ranked and
  // capped to whatever budget remains.
  const requiredProps = kept.filter((prop) => !(prop.flags & ts.SymbolFlags.Optional));
  const optionalProps = kept.filter((prop) => !!(prop.flags & ts.SymbolFlags.Optional));

  const promotedNames = new Set([
    ...sourceReferencedPropNames(fn),
    ...(fileName ? presetPropNames(fileName) : []),
  ]);

  // A single checker call (`getTypeOfSymbolAtLocation`) can recurse arbitrarily
  // deep inside TypeScript's own instantiation machinery for a self-referential
  // generic member (M81 section 6); ranking runs this over every kept prop, not
  // just the 32 survivors, so it needs the same guard as classification below.
  const ranked: { prop: ts.Symbol; rank: PropRank }[] = [];
  for (const prop of optionalProps) {
    try {
      ranked.push({ prop, rank: propRank(prop, checker, promotedNames) });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      if (fileName) warnRecursiveProp(fileName, prop.getName(), sink);
    }
  }
  const orderedOptional = ranked
    .map((r, index) => ({ ...r, index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((r) => r.prop);

  const totalKept = requiredProps.length + orderedOptional.length;
  if (totalKept > MAX_PROPS && fileName) {
    warnPropCap(fileName, totalKept);
  }

  const optionalBudget = Math.max(0, MAX_PROPS - requiredProps.length);
  const ordered = [...requiredProps, ...orderedOptional.slice(0, optionalBudget)];

  const schemas: PropSchema[] = [];
  for (const prop of ordered) {
    try {
      const decl = prop.getDeclarations()?.[0];
      const propType = decl
        ? checker.getTypeOfSymbolAtLocation(prop, decl)
        : checker.getTypeOfSymbol(prop);
      const required = !(prop.flags & ts.SymbolFlags.Optional);

      const schema = classifyType(prop.getName(), propType, required, checker);
      schemas.push(schema);
      // M84: a genuine multi-branch union (mixed primitive+literal, or
      // structurally different shapes like `string | ReactElement`) collapses
      // to one representative value/kind above; disclose every branch it had
      // and which one won, on the same warnings channel every other
      // extraction warning uses.
      const branches = collapsedUnionBranches(propType, checker);
      if (branches && fileName) {
        warnCollapsedUnion(fileName, prop.getName(), branches, schema.kind, sink);
      }
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      if (fileName) warnRecursiveProp(fileName, prop.getName(), sink);
    }
  }

  return schemas;
}

// M84: a boolean whose name is a known contract convention (`asChild`, `as`,
// `render`) always reports provenance:"contract", regardless of which kind
// branch below actually classified it (boolean, function, a degenerate
// object via `isElementOrCallableUnion`, or a string-literal union for a
// polymorphic `as`). Applied once, at the end, so no individual branch needs
// to know about the override.
function classifyType(
  name: string,
  type: ts.Type,
  required: boolean,
  checker: ts.TypeChecker,
): PropSchema {
  const schema = classifyTypeByShape(name, type, required, checker);
  if (CONTRACT_PROP_NAME.test(name)) {
    return { ...schema, provenance: "contract" };
  }
  return schema;
}

function classifyTypeByShape(
  name: string,
  type: ts.Type,
  required: boolean,
  checker: ts.TypeChecker,
): PropSchema {
  // Absent members carry no shape. `null` and `void` are stripped next to
  // `undefined` because a nullable literal union is still a literal union:
  // that is what makes cva's `VariantProps<typeof x>` enumerable.
  const nonUndefinedTypes = nonUndefinedMembers(type);

  // If only one non-undefined type, classify it directly
  const classifyTarget =
    nonUndefinedTypes.length === 1 ? nonUndefinedTypes[0] : type;

  // ReactNode: only a member that IS ReactNode, or one provably assignable
  // from `string` (which ReactNode structurally is and ReactElement is not).
  // A `ReactElement | JSX.Element` member alone no longer qualifies (M81 3b):
  // a plain `ReactNode` renders a placeholder string fine; `ReactElement` does
  // not, because callers run `React.isValidElement()` on it.
  if (isReactNodeMember(type, checker)) {
    return { name, kind: "reactnode", required, values: [], provenance: "placeholder" };
  }

  // M81 3b: `ReactElement | (props) => ReactElement` (Base UI's `render`, and
  // the same "universal customization prop" idiom in other headless
  // libraries) is neither a plain function prop nor a ReactNode: it has no
  // synthesizable field-bag shape either, so it is routed to objectSchema's
  // existing opaque path instead of being classified as `function` below.
  if (isElementOrCallableUnion(classifyTarget, checker)) {
    return objectSchema(name, classifyTarget, required, checker);
  }

  // Function/callback: check all non-undefined members
  if (nonUndefinedTypes.some((t) => t.getCallSignatures().length > 0)) {
    return { name, kind: "function", required, values: [], provenance: "placeholder" };
  }

  // Boolean: either BooleanLike flag or union of true|false literals
  if (
    classifyTarget.flags & ts.TypeFlags.BooleanLike ||
    isBooleanUnion(nonUndefinedTypes)
  ) {
    return { name, kind: "boolean", required, values: [true, false], provenance: "declared" };
  }

  // String literal union
  if (
    nonUndefinedTypes.length > 1 &&
    nonUndefinedTypes.every(
      (m) => m.isStringLiteral() || m.flags & ts.TypeFlags.StringLiteral,
    )
  ) {
    const values = nonUndefinedTypes.map((m) => {
      if (m.isStringLiteral()) return m.value;
      return checker.typeToString(m).replace(/^"(.*)"$/, "$1");
    });
    return { name, kind: "union", required, values, provenance: "declared" };
  }

  // Number literal union
  if (
    nonUndefinedTypes.length > 1 &&
    nonUndefinedTypes.every(
      (m) => m.isNumberLiteral() || m.flags & ts.TypeFlags.NumberLiteral,
    )
  ) {
    const values = nonUndefinedTypes.map((m) => {
      if (m.isNumberLiteral()) return m.value;
      return Number(checker.typeToString(m));
    });
    return { name, kind: "union", required, values, provenance: "declared" };
  }

  // M98 (element-plus-F3): `string | number` is a genuine union of two
  // primitive shapes -- element-plus declares `value`, `width`, `height` and
  // `maxHeight` that way. It matched no branch above and fell through to the
  // opaque path, printing `unknown` with no disclosure while every other
  // multi-shape prop in the same run got one. One synthesized member per
  // branch, so the pool actually exercises both.
  if (isBarePrimitiveUnion(nonUndefinedTypes)) {
    const values = nonUndefinedTypes.map((member) =>
      member.flags & ts.TypeFlags.String ? (namedStringValue(name) ?? "test") : 1,
    );
    return { name, kind: "union", required, values, provenance: "placeholder" };
  }

  // Plain string. M81 3d: `classifyType` has no way to see that a runtime
  // validator (`Intl.NumberFormat`'s `currency` option, a BCP 47 locale tag)
  // will reject the generic placeholder; `namedStringValue` (M84: the single
  // shared definition with `synthesizeValue`'s nested branch) closes the
  // repeatedly-observed false-FAIL classes without claiming every
  // runtime-validated string is now safe.
  if (classifyTarget.flags & ts.TypeFlags.String) {
    const named = namedStringValue(name);
    if (named !== undefined) {
      return { name, kind: "string", required, values: [named], provenance: "heuristic" };
    }
    return { name, kind: "string", required, values: ["test"], provenance: "placeholder" };
  }

  // Plain number
  if (classifyTarget.flags & ts.TypeFlags.Number) {
    return { name, kind: "number", required, values: [1, 5, 20], provenance: "placeholder" };
  }

  // Tuple: fixed arity, so it is neither an open array nor a bag of fields.
  if (checker.isTupleType(classifyTarget)) {
    return tupleSchema(name, classifyTarget, required, checker);
  }

  // Array. M84: when the element type cannot be resolved (commonly an
  // unbound generic) and the name identifies an identity-keyed collection
  // (rows/items a component may key a WeakMap on), the fallback element is a
  // real object, not the generic bare string "item" — see
  // `identityCollectionElement`.
  if (checker.isArrayType(classifyTarget)) {
    const elementTemplate = synthesizeElement(classifyTarget, checker);
    if (elementTemplate !== undefined) {
      return {
        name,
        kind: "array",
        required,
        values: [[], [elementTemplate]],
        elementTemplate,
        provenance: "declared",
      };
    }
    const identityElement = identityCollectionElement(name);
    if (identityElement !== undefined) {
      return {
        name,
        kind: "array",
        required,
        values: [[], [identityElement]],
        elementTemplate: identityElement,
        provenance: "heuristic",
      };
    }
    return {
      name,
      kind: "array",
      required,
      values: [[], ["item"]],
      provenance: "placeholder",
    };
  }

  // Object: one shape, an intersection of them, or a union. A union stands in
  // for its first member, exactly as an array element type does.
  if (isObjectLike(classifyTarget)) {
    return objectSchema(name, classifyTarget, required, checker);
  }
  if (nonUndefinedTypes.length > 1 && nonUndefinedTypes.every(isObjectLike)) {
    return objectSchema(name, nonUndefinedTypes[0], required, checker);
  }

  // M84: a union mixing a primitive type with a literal member (`boolean |
  // 'trap-focus'`, `number | 'any'`) matches none of the pure-kind checks
  // above (not a pure literal union, not boolean-only, not reactnode,
  // element-or-callable, function, or object-like). Pick the first member
  // with a synthesizable primitive kind — a literal preferred over a bare
  // boolean/string/number, since a literal is the more informative sample —
  // so the schema carries a real value instead of falling to "unknown" with
  // an empty value and no disclosure (base-ui's `modal?: boolean |
  // 'trap-focus'` and `step?: number | 'any'`, both silently dropped today).
  // The value comes directly from a real member of the declared type, so
  // provenance is "declared" like any other union-member pick. Gated on at
  // least one member actually being a literal: a union of two bare primitive
  // types with no literal anywhere (`string | number`) has no finite,
  // meaningfully-preferred member to pick over any other — that shape stays
  // the pre-existing "unknown"/degenerate behavior below, unchanged.
  const hasLiteralMember = nonUndefinedTypes.some(
    (m) => m.isStringLiteral() || m.isNumberLiteral() || !!(m.flags & ts.TypeFlags.BooleanLiteral),
  );
  // A single non-undefined member that IS a literal (an optional prop typed
  // exactly `"solo" | undefined`, which strips to one member) reaches here
  // too — the pure-literal-union checks above require 2+ members, and a
  // literal's own flags never overlap the generic String/Number flags the
  // plain-string/-number checks test — so it is a real, if lone, union
  // member the same way a 2+ member literal union is: reported by its own
  // primitive kind rather than the "union" framing multiple choices imply.
  if (nonUndefinedTypes.length >= 1 && hasLiteralMember) {
    for (const member of nonUndefinedTypes) {
      if (member.isStringLiteral()) {
        const kind = nonUndefinedTypes.length === 1 ? "string" : "union";
        return { name, kind, required, values: [member.value], provenance: "declared" };
      }
      if (member.isNumberLiteral()) {
        const kind = nonUndefinedTypes.length === 1 ? "number" : "union";
        return { name, kind, required, values: [member.value], provenance: "declared" };
      }
    }
    for (const member of nonUndefinedTypes) {
      if (member.flags & ts.TypeFlags.BooleanLike) {
        return { name, kind: "boolean", required, values: [true, false], provenance: "declared" };
      }
      if (member.flags & ts.TypeFlags.String) {
        const named = namedStringValue(name);
        return {
          name,
          kind: "string",
          required,
          values: [named ?? "test"],
          provenance: named !== undefined ? "heuristic" : "declared",
        };
      }
      if (member.flags & ts.TypeFlags.Number) {
        return { name, kind: "number", required, values: [1], provenance: "declared" };
      }
    }
  }

  return {
    name,
    kind: "unknown",
    required,
    values: [],
    provenance: "placeholder",
    ...(required
      ? { degenerate: `no value can be enumerated from ${checker.typeToString(type)}` }
      : {}),
  };
}

// `A & B` carries members exactly as `interface C extends A, B` does, but its
// type flag is Intersection rather than Object.
function isObjectLike(type: ts.Type): boolean {
  return !!(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection));
}

// A tuple's arity is part of its type: `[string, string]` filled with three
// items is as wrong as filling it with none.
const MAX_TUPLE_ARITY = 8;

function tupleSchema(
  name: string,
  type: ts.Type,
  required: boolean,
  checker: ts.TypeChecker,
): PropSchema {
  const positions = checker
    .getTypeArguments(type as ts.TypeReference)
    .slice(0, MAX_TUPLE_ARITY);
  const value = positions.map((position) => synthesizeValue(position, checker, 0, newSynth()));
  const missing = positions.length === 0 || value.some((v) => v === undefined);
  return {
    name,
    kind: "object",
    required,
    values: [value],
    provenance: "declared",
    ...(missing ? { degenerate: `tuple positions of ${checker.typeToString(type)}` } : {}),
  };
}

function objectSchema(
  name: string,
  type: ts.Type,
  required: boolean,
  checker: ts.TypeChecker,
): PropSchema {
  const collection = collectionValue(type, checker);
  if (collection) {
    return {
      name,
      kind: "object",
      required,
      values: [collection.value],
      provenance: "declared",
      ...(collection.reason ? { degenerate: collection.reason } : {}),
    };
  }

  const instance = instanceValue(type);
  if (instance !== undefined) {
    return { name, kind: "object", required, values: [instance], provenance: "declared" };
  }

  const opaque = opaqueReason(type, checker);
  if (opaque) {
    return { name, kind: "object", required, values: [{}], degenerate: opaque, provenance: "placeholder" };
  }

  const synth = newSynth(PROP_SYNTH_MAX_DEPTH);
  const shaped = synthesizeValue(type, checker, 0, synth);
  if (isShapedObject(shaped)) {
    // A member the browser cannot receive makes the whole object a stand-in,
    // however well the rest of it synthesized. M84: the outer object's
    // provenance takes the riskiest thing any nested field used — heuristic
    // beats placeholder beats declared — so a consumer deciding whether a
    // crash traces to a harness-supplied value (M85) can read one field on
    // this prop instead of walking the synthesized object itself.
    const provenance = synth.usedHeuristic ? "heuristic" : synth.usedPlaceholder ? "placeholder" : "declared";
    return {
      name,
      kind: "object",
      required,
      values: [shaped],
      provenance,
      ...(synth.notes.length > 0 ? { degenerate: [...new Set(synth.notes)].join("; ") } : {}),
    };
  }

  return {
    name,
    kind: "object",
    required,
    values: [{}],
    degenerate: `no synthesizable members on ${checker.typeToString(type)}`,
    provenance: "placeholder",
  };
}

function isShapedObject(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length > 0 && entries.some(([, v]) => v !== undefined);
}

const SYNTH_MAX_DEPTH = 3;
// A props-level object starts one level above an array element: `board.cells[]`
// is three hops from the prop and still ordinary domain data.
const PROP_SYNTH_MAX_DEPTH = 4;
const SYNTH_MAX_PROPS = 24;

interface SynthContext {
  maxDepth: number;
  // Types on the current path: a recursive type is not re-entered.
  stack: ts.Type[];
  // Members that could not be reproduced faithfully, for the caller's warning.
  notes: string[];
  // M84: whether any nested member's value came from a name-based heuristic
  // (`namedStringValue`) or a generic type-agnostic fallback, so the outer
  // object schema's own `provenance` can reflect the riskiest thing it
  // contains rather than always reading "declared".
  usedHeuristic: boolean;
  usedPlaceholder: boolean;
}

function newSynth(maxDepth = SYNTH_MAX_DEPTH): SynthContext {
  return { maxDepth, stack: [], notes: [], usedHeuristic: false, usedPlaceholder: false };
}

const MAP_TYPES = new Set(["Map", "WeakMap", "ReadonlyMap"]);
const SET_TYPES = new Set(["Set", "WeakSet", "ReadonlySet"]);
// M81 3a: a structural iterable that is neither Map nor Set. Unlike them, a
// real array IS a valid `Iterable<T>` and survives Playwright's serializer
// unchanged, so it carries no `reason` and is not marked degenerate.
const ITERABLE_TYPES = new Set(["Iterable", "IterableIterator"]);
const COLLECTION_ENTRIES = 2;

// The declared name of a built-in type, or undefined for anything a user wrote.
// Synthetic symbols (`__type` for the anonymous mapped type behind `Record`)
// name no type and are left to the ordinary object path.
function builtinName(type: ts.Type): string | undefined {
  const symbol = type.getSymbol();
  const decls = symbol?.getDeclarations();
  if (!symbol || !decls || decls.length === 0) return undefined;
  const name = symbol.getName();
  if (name.startsWith("__")) return undefined;
  return decls.some((d) => isDefaultLibFile(d.getSourceFile().fileName)) ? name : undefined;
}

// Playwright's evaluate serializer has no case for Map or Set (verified in
// playwright-core lib/utils/isomorphic/utilityScriptSerializers.js), so a real
// instance would reach the page as `{}`. The entries travel instead, and the
// prop is reported as degenerate rather than pretending to be an empty object.
function collectionValue(
  type: ts.Type,
  checker: ts.TypeChecker,
): { value: unknown; reason?: string } | undefined {
  const name = builtinName(type);
  if (!name) return undefined;

  // M81 3a: a real array is a valid `Iterable<T>`/`IterableIterator<T>` and
  // does not throw inside `new Set(prop)`; unlike Map/Set it needs no
  // entries-transport `reason` and is not marked degenerate.
  if (ITERABLE_TYPES.has(name)) {
    const args = checker.getTypeArguments(type as ts.TypeReference);
    const element = args[0] ? synthesizeValue(args[0], checker, 1, newSynth()) : undefined;
    return { value: distinctValues(element) };
  }

  if (!MAP_TYPES.has(name) && !SET_TYPES.has(name)) return undefined;

  const args = checker.getTypeArguments(type as ts.TypeReference);
  const reason = `${name} cannot be transported to the browser: passed as entries`;

  if (SET_TYPES.has(name)) {
    const member = args[0] ? synthesizeValue(args[0], checker, 1, newSynth()) : undefined;
    return { value: distinctValues(member), reason };
  }

  const key = args[0] ? synthesizeValue(args[0], checker, 1, newSynth()) : undefined;
  const value = args[1] ? synthesizeValue(args[1], checker, 1, newSynth()) : undefined;
  return {
    value: distinctValues(key).map((k) => [k, cloneSynthesized(value)]),
    reason,
  };
}

// Two entries that a component can tell apart; a shape with no distinguishable
// key collapses to a single entry rather than inventing collisions.
function distinctValues(seed: unknown): unknown[] {
  if (typeof seed === "string") {
    return Array.from({ length: COLLECTION_ENTRIES }, (_, i) => `${seed}-${i + 1}`);
  }
  if (typeof seed === "number") {
    return Array.from({ length: COLLECTION_ENTRIES }, (_, i) => seed + i);
  }
  if (seed === undefined) return [];
  return [seed];
}

function cloneSynthesized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneSynthesized);
  if (value instanceof Date) return new Date(value.getTime());
  if (value && typeof value === "object" && value.constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = cloneSynthesized(v);
    }
    return out;
  }
  return value;
}

// Fixed instants and patterns, so a component that formats them gets real work
// to do. Both survive Playwright's serializer.
const SYNTH_DATE = "2024-01-01T00:00:00.000Z";

function instanceValue(type: ts.Type): unknown {
  const name = builtinName(type);
  if (name === "Date") return new Date(SYNTH_DATE);
  if (name === "RegExp") return /120fps/;
  return undefined;
}

// Anything whose behaviour is its shape: a class instance is its methods, a
// Promise is its resolution, a DOM node is the document it lives in. Inventing
// a field bag for them produces a value the component crashes on.
function opaqueReason(type: ts.Type, checker: ts.TypeChecker): string | undefined {
  const symbol = type.getSymbol();
  const decls = symbol?.getDeclarations() ?? [];
  if (decls.some((d) => ts.isClassDeclaration(d) || ts.isClassExpression(d))) {
    return `${checker.typeToString(type)} is a class instance`;
  }
  const name = builtinName(type);
  if (name && !MAP_TYPES.has(name) && !SET_TYPES.has(name) && !ITERABLE_TYPES.has(name)) {
    return `${name} has no synthesizable shape`;
  }
  // M81 3b: `ReactElement | (props) => ReactElement` (Base UI's `render`
  // idiom): a function/element union has no synthesizable field-bag shape.
  if (isElementOrCallableUnion(type, checker)) {
    return `${checker.typeToString(type)} requires a real element or render function`;
  }
  return undefined;
}

// M81 3b: a union carrying both a React-element-shaped member and a callable
// member, with no primitive/ReactNode member to fall back to. `classifyType`
// uses this to route the shape to `objectSchema` instead of `"function"`;
// `opaqueReason` uses the same test to name it degenerate once there.
function isElementOrCallableUnion(type: ts.Type, checker: ts.TypeChecker): boolean {
  if (!type.isUnion()) return false;
  const members = nonUndefinedMembers(type);
  const hasElement = members.some((t) => /ReactElement|JSX\.Element/.test(checker.typeToString(t)));
  const hasCallable = members.some((t) => t.getCallSignatures().length > 0);
  const hasPrimitive = members.some(
    (t) => t.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike),
  );
  return hasElement && hasCallable && !hasPrimitive;
}

// M84: every printed branch of a union `classifyType` collapsed to one
// representative kind/value, or `undefined` when the union is a case that is
// already fully self-explanatory (a pure string- or number-literal union, a
// boolean union, a plain `ReactNode`) or already disclosed by M81's own
// `degenerate` warning (an element-or-callable union routes through
// `opaqueReason`, which `warnDegenerateProps` already names).
// M98 (element-plus-F3): exactly `string | number` / `number | string`. Bare
// primitives only -- a literal member routes to the literal-union branches, and
// every other mixed shape keeps the behavior it had.
function isBarePrimitiveUnion(members: ts.Type[]): boolean {
  if (members.length < 2) return false;
  const isBare = (member: ts.Type): boolean =>
    !!(member.flags & (ts.TypeFlags.String | ts.TypeFlags.Number)) &&
    !member.isStringLiteral() &&
    !member.isNumberLiteral();
  return (
    members.every(isBare) &&
    members.some((m) => !!(m.flags & ts.TypeFlags.String)) &&
    members.some((m) => !!(m.flags & ts.TypeFlags.Number))
  );
}

function collapsedUnionBranches(type: ts.Type, checker: ts.TypeChecker): string[] | undefined {
  const nonUndefined = nonUndefinedMembers(type);
  if (nonUndefined.length <= 1) return undefined;
  if (isReactNodeMember(type, checker)) return undefined;
  const classifyTarget = nonUndefined.length === 1 ? nonUndefined[0] : type;
  if (isElementOrCallableUnion(classifyTarget, checker)) return undefined;
  if (isBooleanUnion(nonUndefined)) return undefined;
  if (nonUndefined.every((m) => m.isStringLiteral() || !!(m.flags & ts.TypeFlags.StringLiteral))) {
    return undefined;
  }
  if (nonUndefined.every((m) => m.isNumberLiteral() || !!(m.flags & ts.TypeFlags.NumberLiteral))) {
    return undefined;
  }
  // M98: `string | number` now collapses to one representative member per
  // branch, so it gets the disclosure every other union gets. Before M98 it
  // stayed an opaque `unknown` and there was no collapse to describe.
  if (isBarePrimitiveUnion(nonUndefined)) return nonUndefined.map((m) => checker.typeToString(m));
  // A union of bare primitive types with no literal member anywhere has
  // nothing classifyType actually collapsed: the mixed-union fallback above
  // requires a literal to pick from and leaves this shape as the pre-existing
  // "unknown"/degenerate value, unchanged by M84. Disclosing "branches" for a
  // value that stayed empty would describe a collapse that never happened.
  const hasObjectMember = nonUndefined.some(isObjectLike);
  const hasLiteralMember = nonUndefined.some(
    (m) => m.isStringLiteral() || m.isNumberLiteral() || !!(m.flags & ts.TypeFlags.BooleanLiteral),
  );
  if (!hasObjectMember && !hasLiteralMember) return undefined;
  return nonUndefined.map((m) => checker.typeToString(m));
}

// An array whose elements are strings satisfies no object-shaped element type,
// so a scaling sweep over it renders nothing and reports constant growth.
// Build one value shaped like the declared element instead.
export function synthesizeElement(arrayType: ts.Type, checker: ts.TypeChecker): unknown {
  const element = checker.getTypeArguments(arrayType as ts.TypeReference)[0];
  if (!element) return undefined;
  return synthesizeValue(element, checker, 0, newSynth());
}

// M84: `name` is the prop or field this value is being synthesized for, when
// one is known — the object-property loop below passes `prop.name`; every
// other recursive call (union members, tuple positions, array elements,
// Map/Set/Iterable entries) has no single field name to offer and passes
// `undefined`, where the generic fallback is correct because there is no
// name to test a heuristic against. This is the ONLY place besides
// `classifyType`'s own top-level string branch that decides a string value,
// and both call the same `namedStringValue`, so a heuristic added there
// applies at every depth without a second copy to keep in sync (M84's
// depth-independence invariant).
function synthesizeValue(
  type: ts.Type,
  checker: ts.TypeChecker,
  depth: number,
  synth: SynthContext,
  name?: string,
): unknown {
  if (depth >= synth.maxDepth) return undefined;

  if (type.isStringLiteral()) return type.value;
  if (type.isNumberLiteral()) return type.value;
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    return checker.typeToString(type) === "true";
  }
  if (type.flags & ts.TypeFlags.String) {
    const named = namedStringValue(name);
    if (named !== undefined) {
      synth.usedHeuristic = true;
      return named;
    }
    synth.usedPlaceholder = true;
    return "text";
  }
  if (type.flags & ts.TypeFlags.Number) return 1;
  if (type.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLike)) return true;
  if (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {
    return undefined;
  }

  if (type.isUnion()) {
    for (const member of type.types) {
      if (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) continue;
      const value = synthesizeValue(member, checker, depth, synth, name);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  if (checker.isTupleType(type)) {
    const positions = checker
      .getTypeArguments(type as ts.TypeReference)
      .slice(0, MAX_TUPLE_ARITY);
    if (positions.length === 0) return undefined;
    return positions.map((position) => synthesizeValue(position, checker, depth + 1, synth));
  }

  if (checker.isArrayType(type)) {
    const inner = checker.getTypeArguments(type as ts.TypeReference)[0];
    if (!inner) return [];
    const value = synthesizeValue(inner, checker, depth + 1, synth);
    return value === undefined ? [] : [value];
  }

  if (isObjectLike(type)) {
    // Functions and other callables have no data shape worth inventing.
    if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0) {
      return undefined;
    }
    const instance = instanceValue(type);
    if (instance !== undefined) return instance;
    const collection = collectionValue(type, checker);
    if (collection) {
      if (collection.reason) synth.notes.push(collection.reason);
      return collection.value;
    }
    const opaque = opaqueReason(type, checker);
    if (opaque) {
      synth.notes.push(opaque);
      return undefined;
    }
    // A type already on the path is a cycle; the depth cap alone would only
    // bound it, and a bounded cycle is still fabricated nesting.
    if (synth.stack.includes(type)) return undefined;

    const props = checker
      .getPropertiesOfType(type)
      .filter((prop) => !isNoiseProp(prop))
      .slice(0, SYNTH_MAX_PROPS);
    if (props.length === 0) return undefined;

    synth.stack.push(type);
    try {
      const record: Record<string, unknown> = {};
      for (const prop of props) {
        record[prop.name] = synthesizeValue(
          checker.getTypeOfSymbol(prop),
          checker,
          depth + 1,
          synth,
          prop.name,
        );
      }
      return record;
    } finally {
      synth.stack.pop();
    }
  }

  return undefined;
}

function isBooleanUnion(types: ts.Type[]): boolean {
  return (
    types.length === 2 &&
    types.every((t) => t.flags & ts.TypeFlags.BooleanLiteral)
  );
}

// M81 3b: narrower than a bare `ReactElement|JSX\.Element` text match. A
// plain `ReactNode` renders a placeholder string fine (it structurally
// includes `string`); a bare `ReactElement` does not, because callers run
// `React.isValidElement()` on it, which a string fails.
function isReactNodeMember(type: ts.Type, checker: ts.TypeChecker): boolean {
  // Checked against the WHOLE declared type, before it is decomposed into
  // individual union members: TS preserves the `ReactNode` alias name when
  // printing a direct reference to it, but `ReactNode`'s own definition is
  // itself a union (string | number | ReactElement | Iterable<ReactNode> |
  // ...), so none of ITS decomposed members individually prints "ReactNode" -
  // checking per-member (as the milestone's own literal wording suggests)
  // would never match the common case and was verified empirically to fail.
  // An "assignable from string" fallback was tried and rejected: a plain
  // `string` prop, and any `Iterable<string>`-shaped prop, are both trivially
  // string-assignable and would be misclassified as reactnode too.
  return /^(React\.)?ReactNode$/.test(checker.typeToString(type));
}

// M81 3d: commerce-F1. Named runtime-validated string conventions, matched
// before falling back to the generic "test" placeholder. Deliberately narrow:
// closes the one repeatedly-observed false-FAIL class (Intl construction),
// not a general claim that every runtime-validated string is now safe.
const CURRENCY_PROP_NAME = /^currency(code)?$/i;
const LOCALE_PROP_NAME = /^(locale|language)$/i;
// M84: element-plus-F2. A `src`/`srcSet`/`poster` string synthesized as the
// generic "test" placeholder relative-resolves against the harness origin
// and 404s, and the 404 is then wrongly charged to the component. An inline
// `data:` URI (a real, valid 1x1 transparent GIF) resolves with no network
// request at all.
const IMAGE_SRC_PROP_NAME = /^(src|srcset|poster)$/i;
const DATA_URI_PLACEHOLDER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

// M84: the single place a name-based string heuristic is defined. Both
// `classifyType`'s top-level string branch and `synthesizeValue`'s nested
// object-member branch call this, so a heuristic that works one level deep
// works at every level (commerce's control: top-level `currencyCode`
// synthesizes "USD", nested `label.currencyCode` must synthesize the same
// value, not the generic "test" placeholder it fell back to before this
// milestone). Returns `undefined` when no convention matches, meaning the
// caller falls back to its own generic placeholder.
function namedStringValue(name: string | undefined): string | undefined {
  if (!name) return undefined;
  if (CURRENCY_PROP_NAME.test(name)) return "USD";
  if (LOCALE_PROP_NAME.test(name)) return "en-US";
  if (IMAGE_SRC_PROP_NAME.test(name)) return DATA_URI_PLACEHOLDER;
  return undefined;
}

// M84 cross-lane interface: a boolean whose truthiness imposes a contract on
// another prop (M85's asChild/as/render examples). Deliberately narrow, the
// same allowlist shape as the string heuristics above: these three names are
// the one convention observed across Radix, Base UI, react-aria and shadcn
// corpora. A general "any boolean whose true branch changes what another
// prop must be" detector needs cross-prop analysis this milestone does not
// attempt.
const CONTRACT_PROP_NAME = /^(asChild|as|render)$/;

// M84: element-plus-F4. An array whose element type could not be resolved
// (commonly an unbound generic, `T[]`) and whose name identifies it as a
// row/item collection gets a real object element instead of the generic
// bare string "item", so a component keying a `WeakMap`/`Map` on its own
// rows (identity, not content) does not throw `TypeError: Invalid value
// used as weak map key`. A dedicated pattern, not `ITEMS_PATTERN` itself:
// it shares that constant's vocabulary plus "rows", but stays separate so
// this fallback can never change `detectScalingProps`'s existing reason
// text or sort priority for an unrelated, already-resolvable array prop.
const IDENTITY_COLLECTION_NAME = /items|options|data|rows|entries|records|elements|list/i;

function identityCollectionElement(name: string): unknown | undefined {
  return IDENTITY_COLLECTION_NAME.test(name) ? { id: 1 } : undefined;
}

export type { ExportInfo } from "./composition.js";

// Shared sync AST walker for export detection (parse-only, no type checker).
// Recognizes: export function/class/const declarations, export default
// declarations, `export default <Identifier>;` assignments, and
// `export { A, B as default }` clauses (type specifiers skipped).
// PascalCase-filtered; entries deduped by name with isDefault OR-merged.
export function scanExports(sourceText: string, fileName: string): ExportInfo[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    false,
  );

  const byName = new Map<string, { name: string; isDefault: boolean }>();
  const add = (name: string, isDefault: boolean): void => {
    if (!isComponentName(name)) return;
    const existing = byName.get(name);
    if (existing) {
      existing.isDefault = existing.isDefault || isDefault;
    } else {
      byName.set(name, { name, isDefault });
    }
  };

  ts.forEachChild(sourceFile, (node) => {
    // export default <Identifier>;
    if (ts.isExportAssignment(node)) {
      if (!node.isExportEquals && ts.isIdentifier(node.expression)) {
        add(node.expression.text, true);
      }
      return;
    }

    // export { A, B as default }
    if (ts.isExportDeclaration(node)) {
      if (node.isTypeOnly || !node.exportClause || !ts.isNamedExports(node.exportClause)) return;
      for (const spec of node.exportClause.elements) {
        if (spec.isTypeOnly) continue;
        const exported = spec.name.text;
        if (exported === "default") {
          add(spec.propertyName?.text ?? exported, true);
        } else {
          add(exported, false);
        }
      }
      return;
    }

    if (!hasExportModifier(node)) return;
    const isDefault = hasDefaultModifier(node);

    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      add(node.name.text, isDefault);
    }

    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          add(decl.name.text, false);
        }
      }
    }
  });

  return [...byName.values()];
}

// M39: every source file a component's type-check touches, minus default
// libs and external libraries: the file set whose contents identify the
// component for fingerprinting. Rides the M36 program cache.
export async function projectSourceFiles(filePath: string): Promise<string[]> {
  const absolutePath = path.resolve(filePath);
  const files: string[] = [];

  // M57: the program roots at a virtual script, which is not a file anyone can
  // hash. Each `<x>.vue.ts` collapses back to `<x>.vue`: without that an
  // edited component would keep reusing a stored verdict about different source.
  let root = absolutePath;
  let virtual: VirtualScripts | undefined;
  if (isVueFile(absolutePath)) {
    files.push(path.normalize(absolutePath));
    const compiler = await loadVueCompiler(path.dirname(absolutePath));
    if (!compiler) return files;
    virtual = createVueScripts(compiler);
    const entry = vueEntryScript(absolutePath, virtual);
    if (!entry) return files;
    root = entry;
  }

  const program = createCachedProgram(root, createCompilerOptions(absolutePath), virtual);
  for (const sf of program.getSourceFiles()) {
    if (program.isSourceFileDefaultLibrary(sf)) continue;
    if (program.isSourceFileFromExternalLibrary(sf)) continue;
    if (/[\\/]node_modules[\\/]/.test(sf.fileName)) continue;
    const real = /^(.*\.vue)\.(ts|tsx)$/i.exec(path.normalize(sf.fileName))?.[1];
    files.push(real ?? path.normalize(sf.fileName));
  }
  return [...new Set(files)].sort();
}

export async function extractExports(filePath: string): Promise<ExportInfo[]> {
  const absolutePath = path.resolve(filePath);
  const sourceText = ts.sys.readFile(absolutePath);
  if (sourceText === undefined) return [];
  return scanExports(sourceText, absolutePath);
}

export async function extractAllProps(filePath: string): Promise<Map<string, PropSchema[]>> {
  const absolutePath = path.resolve(filePath);
  const options = createCompilerOptions(absolutePath);
  const program = createCachedProgram(absolutePath, options);
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(absolutePath);
  if (!sourceFile) return new Map();

  const result = new Map<string, PropSchema[]>();

  ts.forEachChild(sourceFile, (node) => {
    if (!hasExportModifier(node)) return;

    if (ts.isFunctionDeclaration(node) && node.name && node.parameters.length > 0) {
      const name = node.name.text;
      if (!isComponentName(name)) return;
      const param = node.parameters[0];
      const type = checker.getTypeAtLocation(param);
      if (looksLikePropsType(type, checker)) {
        result.set(name, typeToSchema(type, checker));
      } else {
        result.set(name, []);
      }
    }

    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const name = decl.name.text;
        if (!isComponentName(name)) continue;
        const fn = extractFunctionFromInitializer(decl.initializer);
        if (fn && fn.parameters.length > 0) {
          const type = checker.getTypeAtLocation(fn.parameters[0]);
          if (looksLikePropsType(type, checker)) {
            result.set(name, typeToSchema(type, checker));
          } else {
            result.set(name, []);
          }
        } else {
          result.set(name, []);
        }
      }
    }
  });

  return result;
}

// One warning per tsconfig path per process (M24 D6).
const warnedTsconfigPaths = new Set<string>();

function warnTsconfigOnce(configPath: string, detail: string): void {
  if (warnedTsconfigPaths.has(configPath)) return;
  warnedTsconfigPaths.add(configPath);
  process.stderr.write(`Warning: problem reading tsconfig at ${configPath}: ${detail}\n`);
}

// The same options prop extraction resolves under, so a preflight walk follows
// the same tsconfig paths the measured graph does.
export function projectCompilerOptions(absolutePath: string): ts.CompilerOptions {
  return createCompilerOptions(path.resolve(absolutePath));
}

function createCompilerOptions(absolutePath: string): ts.CompilerOptions {
  // M69: the same search the harness builds aliases from, so one config
  // governs both. The bound is the workspace root; a tree with no package.json
  // anywhere has no project model, and the walk keeps its old reach.
  const startDir = path.dirname(absolutePath);
  const memberRoot = findProjectRoot(startDir);
  const tsconfigPath = findCompilerConfig(
    startDir,
    memberRoot === undefined ? undefined : findWorkspaceRoot(memberRoot),
  );

  let compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
    skipLibCheck: true,
    // A .jsx target is outside the program without this, so extraction has no
    // source file to read and reports the component as unparsable.
    allowJs: true,
  };

  if (tsconfigPath) {
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (configFile.error) {
      warnTsconfigOnce(
        tsconfigPath,
        ts.flattenDiagnosticMessageText(configFile.error.messageText, " "),
      );
    } else {
      const parsed = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        path.dirname(tsconfigPath),
      );
      if (parsed.errors.length > 0) {
        warnTsconfigOnce(
          tsconfigPath,
          ts.flattenDiagnosticMessageText(parsed.errors[0].messageText, " "),
        );
      }
      // Override resolution to Bundler: user components use extensionless imports
      compilerOptions = {
        ...parsed.options,
        skipLibCheck: true,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        module: ts.ModuleKind.ESNext,
        // The measured file is named by the user: a project that excludes
        // JavaScript from type checking still gets its .jsx component read.
        allowJs: true,
      };
    }
  }

  return compilerOptions;
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function hasDefaultModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
}

function isComponentName(name: string): boolean {
  if (!/^[A-Z]/.test(name)) return false;
  if (/^[A-Z_][A-Z0-9_]*$/.test(name)) return false;
  return true;
}
