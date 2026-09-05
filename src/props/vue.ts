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

// Served from memory under `<sfc>.ts` in the SFC's directory, so relative imports resolve as usual.
export interface VirtualScripts {
  has(fileName: string): boolean;
  read(fileName: string): string | undefined;
}



interface DefinePropsCall {
  typeNode?: ts.TypeNode;
  // The second argument of `withDefaults`, when the call is wrapped in one.
  defaults?: ts.ObjectLiteralExpression;
}


// A macro identifier is always literal, and the props type is a type argument, not a parameter.
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


// Every anchor reads `values[0]`, so the declared default leads the pool.
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

  // The trailing `true` reorders the pool so the default leads it.
  return applyDeclaredDefaults(schemas, byName, "withDefaults", true);
}


// One resolver serves the measured file and every `.vue` it imports.
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
      // An SFC with no <script setup> is still an importable module with no declarations.
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


// States what is true: props exist in a form ADR 0002 does not read, so nothing failed.
const OPTIONS_API_WARNING_MARK = "Vue's Options API";


export const VUE_OPTIONS_API_PROPS_WARNING = (
  absolutePath: string,
  form: "props" | "extends" | "mixins",
): string =>
  `${absolutePath} declares props through ${OPTIONS_API_WARNING_MARK} ("${form}"), a runtime form ` +
  `ADR 0002 deliberately does not read: extraction did not fail and the component is not broken.` +
  presetRemedyClause(absolutePath);


// Lets isVuePropsScopeExclusionWarning recognize this warning without parsing prose.
export function isVueOptionsApiPropsWarning(message: string): boolean {
  return message.includes(OPTIONS_API_WARNING_MARK);
}


// Without this the generic "extraction may have failed" would imply a malfunction.
const RUNTIME_DEFINE_PROPS_WARNING_MARK = "a runtime defineProps({...}) call";


export const VUE_RUNTIME_DEFINE_PROPS_WARNING = (absolutePath: string): string =>
  `${absolutePath} declares props through ${RUNTIME_DEFINE_PROPS_WARNING_MARK}, a runtime form ADR ` +
  `0002 deliberately does not read: extraction did not fail and the component is not broken.` +
  presetRemedyClause(absolutePath) +
  " Switching to defineProps<T>() gets automatic extraction.";


export function isVueRuntimeDefinePropsWarning(message: string): boolean {
  return message.includes(RUNTIME_DEFINE_PROPS_WARNING_MARK);
}


// Calling this the Options API would name a mechanism the file does not use.
const SETUP_RUNTIME_PROPS_WARNING_MARK = "a runtime props object read by setup()";


export const VUE_SETUP_RUNTIME_PROPS_WARNING = (absolutePath: string): string =>
  `${absolutePath} declares props through ${SETUP_RUNTIME_PROPS_WARNING_MARK} (Vue's Composition ` +
  `API), a runtime form ADR 0002 deliberately does not read: extraction did not fail and the ` +
  `component is not broken.` +
  presetRemedyClause(absolutePath);


export function isVueSetupRuntimePropsWarning(message: string): boolean {
  return message.includes(SETUP_RUNTIME_PROPS_WARNING_MARK);
}


// A resolution failure, so it stays out of isVuePropsScopeExclusionWarning.
const UNRESOLVED_DEFINE_PROPS_MARK = "defineProps<T>() type argument";


export const VUE_UNRESOLVED_PROPS_TYPE_WARNING = (
  absolutePath: string,
  typeText: string,
): string =>
  `Warning: ${UNRESOLVED_DEFINE_PROPS_MARK} "${typeText}" in ${absolutePath} could not be resolved: ` +
  `nothing the SFC's script blocks declare or import provides it.` +
  // A preset on disk means props were measured, so the text must not claim none were.
  (detectPropPresets(absolutePath)
    ? presetRemedyClause(absolutePath)
    : ` No props were extracted.${presetRemedyClause(absolutePath)}`) +
  "\n";


export function isVueUnresolvedPropsTypeWarning(message: string): boolean {
  return message.includes(UNRESOLVED_DEFINE_PROPS_MARK);
}


// One check, so src/pipeline/remedies.ts never has to know the runtime forms apart.
export function isVuePropsScopeExclusionWarning(message: string): boolean {
  return (
    isVueOptionsApiPropsWarning(message) ||
    isVueRuntimeDefinePropsWarning(message) ||
    isVueSetupRuntimePropsWarning(message)
  );
}


// ADR 0002: TypeScript only, so the runtime object form yields no schemas.
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
    // `call` defined with no type argument is the runtime form; undefined is a file with no macro.
    if (call) {
      sink?.(VUE_RUNTIME_DEFINE_PROPS_WARNING(absolutePath));
      return [];
    }
    const source = ts.sys.readFile(absolutePath);
    if (source !== undefined && parseSfcScript(source, absolutePath, compiler) === undefined) {
      const form = detectOptionsApiProps(source, absolutePath, compiler);
      // `props:` beside `setup()` is the Composition API's runtime form.
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

  // The sink reaches typeToSchema so Vue disclosures land in the same warnings list.
  const schemas = applyWithDefaults(
    typeToSchema(propsType, checker, absolutePath, sink, undefined, record),
    call.defaults,
  );
  warnDegenerateProps(absolutePath, schemas, sink, record);
  return schemas;
}


// TypeScript's error type is `any`, which tells a missing declaration from an empty `{}`.
function unresolvedPropsTypeText(typeNode: ts.TypeNode, propsType: ts.Type): string | undefined {
  if (!(propsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) return undefined;
  return typeNode.getText();
}


// Undefined when the SFC has no <script setup> to serve.
export function vueEntryScript(vuePath: string, virtual: VirtualScripts): string | undefined {
  for (const lang of ["ts", "tsx"]) {
    const candidate = virtualScriptPath(vuePath, lang);
    if (virtual.has(candidate)) return candidate;
  }
  return undefined;
}
