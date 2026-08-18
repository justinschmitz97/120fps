import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import type { ExportInfo } from "./composition.js";
import {
  isVueFile,
  loadVueCompiler,
  parseSfcScript,
  virtualScriptPath,
  type SfcScript,
  type VueSfcCompiler,
} from "./vue-sfc.js";
import { detectPropPresets, literalValue } from "./prop-presets.js";

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
// for a real file — and so `./Child.vue` resolves too, because TS's bundler
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
  const program = ts.createProgram([rootFile], options, host, oldProgram);
  extractionCache.lastProgram = program;
  extractionCache.lastOptionsKey = optionsKey;
  extractionCache.programsCreated++;
  return program;
}

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

export function detectScalingProps(schemas: PropSchema[]): ScalingPropMatch[] {
  const matches: ScalingPropMatch[] = [];

  for (const schema of schemas) {
    if (ARIA_PATTERN.test(schema.name)) continue;
    if (schema.kind === "array" && ITEMS_PATTERN.test(schema.name)) {
      matches.push({ schema, kind: "array", reason: "array prop with items-like name" });
    } else if (schema.kind === "array") {
      matches.push({ schema, kind: "array", reason: "array prop" });
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

  const program = createCachedProgram(absolutePath, createCompilerOptions(absolutePath));
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(absolutePath);

  if (!sourceFile) {
    throw new Error(`Could not parse ${filePath}`);
  }

  const binding = findComponentPropsType(
    sourceFile,
    checker,
    options?.target,
    collecting ? sink : undefined,
  );
  const schemas = binding.type ? typeToSchema(binding.type, checker, absolutePath) : [];

  if (schemas.length === 0 && binding.computedAnnotation && binding.targetName) {
    warnUnenumerableProps(
      absolutePath,
      binding.targetName,
      binding.computedAnnotation,
      collecting ? sink : undefined,
    );
  }
  warnDegenerateProps(absolutePath, schemas, collecting ? sink : undefined);

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

// `defineProps` is a compiler macro, so the identifier is always literal — no
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
// the pipeline reads `values[0]` — deltas, matrix baselines, curve anchors. So
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

  return schemas.map((schema) => {
    if (!byName.has(schema.name)) return schema;
    const value = byName.get(schema.name);
    const rest = schema.values.filter((v) => !Object.is(v, value));
    return { ...schema, values: [value, ...rest] };
  });
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
  if (!call?.typeNode) return [];

  const checker = program.getTypeChecker();
  const propsType = checker.getTypeFromTypeNode(call.typeNode);
  if (!looksLikePropsType(propsType, checker)) return [];

  const schemas = applyWithDefaults(
    typeToSchema(propsType, checker, absolutePath),
    call.defaults,
  );
  warnDegenerateProps(absolutePath, schemas, sink);
  return schemas;
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
    // `export default memo(Imported)` — the component is not declared here.
    | ts.ExportAssignment;
  exported: boolean;
  isDefault: boolean;
  // Names the module exports this declaration under, when they differ from the
  // local one (`export { Core as AliasWidget }`).
  aliases: string[];
}

interface BoundProps {
  type: ts.Type;
  // The function the type came from, when one was reachable — the source of
  // the destructured parameter names the self-consistency guard compares.
  fn?: ts.SignatureDeclaration;
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
        // export default function (props: Props) — nameless but still the target.
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
    return stemMatch ?? exported[0];
  }

  return candidates[0];
}

// `memo(Inner)` / `forwardRef(Inner)` / `Inner` — the identifier a wrapper chain
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

  // const Component = memo(Inner) — follow the identifier to its declaration.
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
    if (looksLikePropsType(paramType, checker)) return { type: paramType };
  }

  return undefined;
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
    `Warning: could not resolve props for ${targetName} in ${fileName} — measuring with no props. ` +
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
    `Warning: props type ${annotation} for ${targetName} in ${fileName} could not be enumerated — ` +
      `measuring with no props. Add ${presetFileName(fileName)} to supply values.\n`,
    sink,
  );
}

interface PropsBinding {
  type?: ts.Type;
  targetName?: string;
  // 1-based source line of the target's declaration.
  targetLine?: number;
  // The target's first-parameter annotation, when it is a computed type — the
  // only case where an empty schema is a resolution failure rather than a fact.
  computedAnnotation?: string;
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
  const target = selectTargetCandidate(candidates, sourceFile.fileName, explicitTarget);
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

  if (bound) return { type: bound.type, ...context };

  if (expectsProps(target)) {
    const hijacker = candidates.some(
      (candidate) => candidate !== target && bindProps(candidate, checker, byName),
    );
    if (hijacker) warnUnboundTarget(sourceFile.fileName, target.name, sink);
  }

  return context;
}

function extractFunctionFromInitializer(
  node: ts.Expression,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return node;
  }

  // Recursively unwrap HOC chains: memo(forwardRef((props, ref) => ...))
  if (ts.isCallExpression(node)) {
    const args = node.arguments;
    if (args.length > 0) {
      return extractFunctionFromInitializer(args[0]);
    }
  }

  return undefined;
}

function looksLikePropsType(type: ts.Type, checker: ts.TypeChecker): boolean {
  const props = type.getProperties();
  if (props.length === 0) return false;

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

function isNoiseProp(prop: ts.Symbol): boolean {
  if (NOISE_PROP_NAME.test(prop.getName())) return true;
  const decls = prop.getDeclarations();
  if (!decls || decls.length === 0) return false;
  return decls.every(isAmbientNoiseDeclaration);
}

function typeToSchema(
  type: ts.Type,
  checker: ts.TypeChecker,
  fileName?: string,
): PropSchema[] {
  const kept = type.getProperties().filter((prop) => !isNoiseProp(prop));

  // A component's own props answer the question; inherited third-party ones are
  // context. Ordering by that keeps the cap from spending itself on context.
  const declaredHere = (prop: ts.Symbol): boolean =>
    prop.getDeclarations()?.some(isLocalDeclaration) ?? false;
  const ordered = [...kept.filter(declaredHere), ...kept.filter((p) => !declaredHere(p))];

  if (ordered.length > MAX_PROPS && fileName) {
    warnPropCap(fileName, ordered.length);
  }

  const schemas: PropSchema[] = [];
  for (const prop of ordered.slice(0, MAX_PROPS)) {
    const decl = prop.getDeclarations()?.[0];
    const propType = decl
      ? checker.getTypeOfSymbolAtLocation(prop, decl)
      : checker.getTypeOfSymbol(prop);
    const required = !(prop.flags & ts.SymbolFlags.Optional);

    schemas.push(classifyType(prop.getName(), propType, required, checker));
  }

  return schemas;
}

function classifyType(
  name: string,
  type: ts.Type,
  required: boolean,
  checker: ts.TypeChecker,
): PropSchema {
  // Absent members carry no shape. `null` and `void` are stripped next to
  // `undefined` because a nullable literal union is still a literal union —
  // that is what makes cva's `VariantProps<typeof x>` enumerable.
  const nonUndefinedTypes = type.isUnion()
    ? type.types.filter(
        (t) =>
          !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)),
      )
    : [type];

  // If only one non-undefined type, classify it directly
  const classifyTarget =
    nonUndefinedTypes.length === 1 ? nonUndefinedTypes[0] : type;

  // ReactNode / ReactElement — check all non-undefined members
  if (nonUndefinedTypes.some((t) => isReactNodeType(t, checker))) {
    return { name, kind: "reactnode", required, values: [] };
  }

  // Function/callback — check all non-undefined members
  if (nonUndefinedTypes.some((t) => t.getCallSignatures().length > 0)) {
    return { name, kind: "function", required, values: [] };
  }

  // Boolean — either BooleanLike flag or union of true|false literals
  if (
    classifyTarget.flags & ts.TypeFlags.BooleanLike ||
    isBooleanUnion(nonUndefinedTypes)
  ) {
    return { name, kind: "boolean", required, values: [true, false] };
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
    return { name, kind: "union", required, values };
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
    return { name, kind: "union", required, values };
  }

  // Plain string
  if (classifyTarget.flags & ts.TypeFlags.String) {
    return { name, kind: "string", required, values: ["test"] };
  }

  // Plain number
  if (classifyTarget.flags & ts.TypeFlags.Number) {
    return { name, kind: "number", required, values: [1, 5, 20] };
  }

  // Tuple — fixed arity, so it is neither an open array nor a bag of fields.
  if (checker.isTupleType(classifyTarget)) {
    return tupleSchema(name, classifyTarget, required, checker);
  }

  // Array
  if (checker.isArrayType(classifyTarget)) {
    const elementTemplate = synthesizeElement(classifyTarget, checker);
    return {
      name,
      kind: "array",
      required,
      values: [[], [elementTemplate === undefined ? "item" : elementTemplate]],
      ...(elementTemplate === undefined ? {} : { elementTemplate }),
    };
  }

  // Object — one shape, an intersection of them, or a union. A union stands in
  // for its first member, exactly as an array element type does.
  if (isObjectLike(classifyTarget)) {
    return objectSchema(name, classifyTarget, required, checker);
  }
  if (nonUndefinedTypes.length > 1 && nonUndefinedTypes.every(isObjectLike)) {
    return objectSchema(name, nonUndefinedTypes[0], required, checker);
  }

  return {
    name,
    kind: "unknown",
    required,
    values: [],
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
    return { name, kind: "object", required, values: [collection.value], degenerate: collection.reason };
  }

  const instance = instanceValue(type);
  if (instance !== undefined) {
    return { name, kind: "object", required, values: [instance] };
  }

  const opaque = opaqueReason(type, checker);
  if (opaque) {
    return { name, kind: "object", required, values: [{}], degenerate: opaque };
  }

  const synth = newSynth(PROP_SYNTH_MAX_DEPTH);
  const shaped = synthesizeValue(type, checker, 0, synth);
  if (isShapedObject(shaped)) {
    // A member the browser cannot receive makes the whole object a stand-in,
    // however well the rest of it synthesized.
    return {
      name,
      kind: "object",
      required,
      values: [shaped],
      ...(synth.notes.length > 0 ? { degenerate: [...new Set(synth.notes)].join("; ") } : {}),
    };
  }

  return {
    name,
    kind: "object",
    required,
    values: [{}],
    degenerate: `no synthesizable members on ${checker.typeToString(type)}`,
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
}

function newSynth(maxDepth = SYNTH_MAX_DEPTH): SynthContext {
  return { maxDepth, stack: [], notes: [] };
}

const MAP_TYPES = new Set(["Map", "WeakMap", "ReadonlyMap"]);
const SET_TYPES = new Set(["Set", "WeakSet", "ReadonlySet"]);
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
): { value: unknown; reason: string } | undefined {
  const name = builtinName(type);
  if (!name || (!MAP_TYPES.has(name) && !SET_TYPES.has(name))) return undefined;

  const args = checker.getTypeArguments(type as ts.TypeReference);
  const reason = `${name} cannot be transported to the browser — passed as entries`;

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
  if (name && !MAP_TYPES.has(name) && !SET_TYPES.has(name)) {
    return `${name} has no synthesizable shape`;
  }
  return undefined;
}

// An array whose elements are strings satisfies no object-shaped element type,
// so a scaling sweep over it renders nothing and reports constant growth.
// Build one value shaped like the declared element instead.
export function synthesizeElement(arrayType: ts.Type, checker: ts.TypeChecker): unknown {
  const element = checker.getTypeArguments(arrayType as ts.TypeReference)[0];
  if (!element) return undefined;
  return synthesizeValue(element, checker, 0, newSynth());
}

function synthesizeValue(
  type: ts.Type,
  checker: ts.TypeChecker,
  depth: number,
  synth: SynthContext,
): unknown {
  if (depth >= synth.maxDepth) return undefined;

  if (type.isStringLiteral()) return type.value;
  if (type.isNumberLiteral()) return type.value;
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    return checker.typeToString(type) === "true";
  }
  if (type.flags & ts.TypeFlags.String) return "text";
  if (type.flags & ts.TypeFlags.Number) return 1;
  if (type.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLike)) return true;
  if (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {
    return undefined;
  }

  if (type.isUnion()) {
    for (const member of type.types) {
      if (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) continue;
      const value = synthesizeValue(member, checker, depth, synth);
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
      synth.notes.push(collection.reason);
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

function isReactNodeType(type: ts.Type, checker: ts.TypeChecker): boolean {
  const typeStr = checker.typeToString(type);
  return /ReactNode|ReactElement|JSX\.Element/.test(typeStr);
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
// libs and external libraries — the file set whose contents identify the
// component for fingerprinting. Rides the M36 program cache.
export async function projectSourceFiles(filePath: string): Promise<string[]> {
  const absolutePath = path.resolve(filePath);
  const files: string[] = [];

  // M57: the program roots at a virtual script, which is not a file anyone can
  // hash. Each `<x>.vue.ts` collapses back to `<x>.vue` — without that an
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
  const tsconfigPath = ts.findConfigFile(
    path.dirname(absolutePath),
    ts.sys.fileExists,
    "tsconfig.json",
  );

  let compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
    skipLibCheck: true,
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
      // Override resolution to Bundler — user components use extensionless imports
      compilerOptions = {
        ...parsed.options,
        skipLibCheck: true,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        module: ts.ModuleKind.ESNext,
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
