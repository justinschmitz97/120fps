import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  detectOptionsApiProps,
  isVueFile,
  loadVueCompiler,
  parseSfcScript,
  virtualScriptPath,
  createCompilerOptions,
  type SfcScript,
  type VueSfcCompiler,
} from "../project/index.js";
import { applyDeclaredDefaults, looksLikePropsType } from "./candidates.js";
import { presetRemedyClause, typeToSchema, warnDegenerateProps } from "./classify.js";
import { detectPropPresets, literalValue } from "./presets.js";
import { createCachedProgram } from "./program.js";
import type { PropSchema, WarningRecorder } from "./schema.js";

// A `.vue` script block has no file of its own. It is served to the
// program from memory under a `<sfc>.ts` name in the SFC's own directory, so
// relative imports, tsconfig `paths` and the checker resolve exactly as they do
// for a real file: and so `./Child.vue` resolves too, because TS's bundler
// resolution probes `./Child.vue.ts` for a specifier it cannot otherwise place.
// Never cached by stamp: virtual files have none, which is what keeps them fresh.
export interface VirtualScripts {
  has(fileName: string): boolean;
  read(fileName: string): string | undefined;
}



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

  // The value was already moved to the front of the pool; it is now
  // also named as the default it is.
  return applyDeclaredDefaults(schemas, byName, "withDefaults", true);
}


// Every `<x>.vue.ts` (or `.tsx`, when the block says so) in the tree resolves to
// the script block of `<x>.vue`, parsed on demand. One entry point serves the
// measured file and every `.vue` it imports.
export function createVueScripts(compiler: VueSfcCompiler): VirtualScripts {
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


// Names the excluded declaration form so the warning states what
// IS true (props exist, in a form ADR 0002 deliberately does not read)
// instead of implying extraction failed or the component is broken. Same
// arrow-function shape and call convention as UNCOMPOSED_SIBLINGS_WARNING
// (composition.ts): a pure `(args) => string`, pushed straight through
// `sink?.()`, not routed through `emit`/`warnOnce`'s stderr-dedup path.
const OPTIONS_API_WARNING_MARK = "Vue's Options API";


export const VUE_OPTIONS_API_PROPS_WARNING = (
  absolutePath: string,
  form: "props" | "extends" | "mixins",
): string =>
  `${absolutePath} declares props through ${OPTIONS_API_WARNING_MARK} ("${form}"), a runtime form ` +
  `ADR 0002 deliberately does not read: extraction did not fail and the component is not broken.` +
  presetRemedyClause(absolutePath);


// Lets extractSchemas (src/pipeline/analyze.ts) recognize this specific warning among
// everything else onWarning may report, without parsing prose or duplicating
// the message text.
export function isVueOptionsApiPropsWarning(message: string): boolean {
  return message.includes(OPTIONS_API_WARNING_MARK);
}


// The <script setup> sibling of the Options-API case
// above -- a runtime-object `defineProps({...})` call (element-plus's
// split-bar.vue shape) is also an ADR 0002 scope exclusion, not a possible
// extraction failure. Without this warning, the shape would produce no
// warning at all (extractVueProps returning [] silently), so the pipeline's
// generic "No props extracted ... extraction may have failed" fallback
// would fire instead and imply a malfunction for a deliberate decision.
// Same register as VUE_OPTIONS_API_PROPS_WARNING on purpose.
const RUNTIME_DEFINE_PROPS_WARNING_MARK = "a runtime defineProps({...}) call";


export const VUE_RUNTIME_DEFINE_PROPS_WARNING = (absolutePath: string): string =>
  `${absolutePath} declares props through ${RUNTIME_DEFINE_PROPS_WARNING_MARK}, a runtime form ADR ` +
  `0002 deliberately does not read: extraction did not fail and the component is not broken.` +
  presetRemedyClause(absolutePath) +
  " Switching to defineProps<T>() gets automatic extraction.";


export function isVueRuntimeDefinePropsWarning(message: string): boolean {
  return message.includes(RUNTIME_DEFINE_PROPS_WARNING_MARK);
}


// `defineComponent({ props: selectProps, setup(props, ...) })`
// is Vue's Composition API with a runtime props object. Calling it "Vue's
// Options API" would name a mechanism the file does not use and would point
// a user fixing it at the wrong pattern. Same scope-exclusion register as
// the two warnings above; the remedy is unchanged because it is already
// correct.
const SETUP_RUNTIME_PROPS_WARNING_MARK = "a runtime props object read by setup()";


export const VUE_SETUP_RUNTIME_PROPS_WARNING = (absolutePath: string): string =>
  `${absolutePath} declares props through ${SETUP_RUNTIME_PROPS_WARNING_MARK} (Vue's Composition ` +
  `API), a runtime form ADR 0002 deliberately does not read: extraction did not fail and the ` +
  `component is not broken.` +
  presetRemedyClause(absolutePath);


export function isVueSetupRuntimePropsWarning(message: string): boolean {
  return message.includes(SETUP_RUNTIME_PROPS_WARNING_MARK);
}


// `defineProps<BadgeProps>()` on a name nothing in the
// program declares yields TypeScript's error type, which `looksLikePropsType`
// rejects -- and the rejection returns `[]` with no `sink?.()` call at all, so
// the only text a user sees is the pipeline's generic "extraction may have
// failed". This is a resolution failure rather than an ADR 0002 scope
// exclusion, so it deliberately stays out of
// `isVuePropsScopeExclusionWarning`.
const UNRESOLVED_DEFINE_PROPS_MARK = "defineProps<T>() type argument";


export const VUE_UNRESOLVED_PROPS_TYPE_WARNING = (
  absolutePath: string,
  typeText: string,
): string =>
  `Warning: ${UNRESOLVED_DEFINE_PROPS_MARK} "${typeText}" in ${absolutePath} could not be resolved: ` +
  `nothing the SFC's script blocks declare or import provides it.` +
  // This resolution warning also branches on whether a preset is already
  // on disk, so it does not claim nothing was extracted while the preset's
  // own props are being measured.
  (detectPropPresets(absolutePath)
    ? presetRemedyClause(absolutePath)
    : ` No props were extracted.${presetRemedyClause(absolutePath)}`) +
  "\n";


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


// Per ADR 0002 this stays TypeScript-only: the runtime object form
// (`defineProps({ label: String })`) carries no types and yields no schemas,
// exactly as an untyped React component does.
export async function extractVueProps(
  absolutePath: string,
  sink?: (message: string) => void,
  record?: WarningRecorder,
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
    // This branch is reached three ways
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
      // `props:` alongside `setup()` is the Composition
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
    // The one zero-prop Vue path that reports why, instead of staying silent.
    const unresolved = unresolvedPropsTypeText(call.typeNode, propsType);
    if (unresolved) sink?.(VUE_UNRESOLVED_PROPS_TYPE_WARNING(absolutePath, unresolved));
    return [];
  }

  // The sink reaches `typeToSchema` here the way it already does on the
  // React path, so a Vue prop's collapsed-union, cap and recursion
  // disclosures land in the same warnings list every other extraction
  // warning does.
  const schemas = applyWithDefaults(
    typeToSchema(propsType, checker, absolutePath, sink, undefined, record),
    call.defaults,
  );
  warnDegenerateProps(absolutePath, schemas, sink, record);
  return schemas;
}


// TypeScript's error type is `any`, and a props type that reaches this
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
export function vueEntryScript(vuePath: string, virtual: VirtualScripts): string | undefined {
  for (const lang of ["ts", "tsx"]) {
    const candidate = virtualScriptPath(vuePath, lang);
    if (virtual.has(candidate)) return candidate;
  }
  return undefined;
}
