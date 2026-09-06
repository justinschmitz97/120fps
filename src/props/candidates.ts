import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  extractFunctionFromInitializer,
  followReExportedComponent,
  hasDefaultModifier,
  hasExportModifier,
  isComponentName,
  RE_EXPORT_HOPS,
  scanExports,
} from "./exports.js";
import { emit } from "./extract.js";
import { literalValue } from "./presets.js";
import type { ExportInfo, PropSchema } from "./schema.js";
import { REACT_TYPE_PACKAGE } from "./synthesize.js";

// Source order: selectTargetCandidate falls back to the first entry.
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
  // Export names that differ from the local one: `export { Core as AliasWidget }`.
  aliases: string[];
}


// Only the package.json naming this exact entry types it; one further up types its own barrel.
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


// ADR 0004: resolveModuleName prefers the `.d.ts` beside the `.js`, as an importer resolves it.
export function resolveEntryDeclaration(
  absolutePath: string,
  options: ts.CompilerOptions,
): string | undefined {
  const stem = path.basename(absolutePath, path.extname(absolutePath));
  const resolved = ts.resolveModuleName(`./${stem}`, absolutePath, options, ts.sys).resolvedModule
    ?.resolvedFileName;
  if (resolved && resolved !== absolutePath && resolved.endsWith(".d.ts")) return resolved;
  return declaringPackageTypes(absolutePath);
}


// Props as an importer reads them: the exported symbol's first call signature's first parameter.
export function propsFromDeclaration(
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
  // Source of the destructured names the self-consistency guard compares.
  fn?: ts.SignatureDeclaration;
  // bindProps's last resort; a JS entry's sibling declaration outranks it (ADR 0004).
  viaTypeFallback?: boolean;
}


const IDENTIFIER_HOPS = 8;


// Shared with detectComponentExport so the harness renders the component whose props were read.
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
        // A local declaration of the name was pushed earlier and wins selection.
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


// Order: default export > stem match > first exported > first declaration (nothing exported).
function selectTargetCandidate(
  candidates: ComponentCandidate[],
  fileName: string,
  sourceText: string,
  explicitTarget?: string,
): ComponentCandidate | undefined {
  // `<file>#Export` names what the harness imports, so it outranks the order below; aliases count.
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

    // scanExports order rather than declaration order: detectComponentExport reads the same list.
    const measured = selectMeasuredExport(scanExports(sourceText, fileName), fileName);
    const measuredMatch = measured
      ? exported.find((c) => [c.name, ...c.aliases].includes(measured))
      : undefined;
    return measuredMatch ?? exported[0];
  }

  return candidates[0];
}


// One pick for both: src/harness/exports.ts's detectComponentExport delegates here.
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


// The identifier a wrapper chain names: `memo(Inner)`, `forwardRef(Inner)`, `Inner`.
export function identifierBehind(expression: ts.Expression): ts.Identifier | undefined {
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

  // `const Component: FC<Props> = <callable>`, or a default export declared in another module.
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


// A non-literal default (a call, a variable) is left unrecorded rather than guessed at.
export function destructuredParameterDefaults(
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

  // A component may destructure props in the body instead of the parameter list.
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


// Parse-only: a top-level `Component.defaultProps = {...}` in the component's own file.
export function defaultPropsAssignment(
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


// reorderValues puts the default first, as Vue's withDefaults does; a React default keeps order.
export function applyDeclaredDefaults(
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


// A rename resolves to the source property; a rest element is dropped.
export function destructuredParameterNames(fn: ts.SignatureDeclaration | undefined): string[] {
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


// A component that declares no parameter has no props to miss: its empty schema is an answer.
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
  // An alias or a factory call may still be a component; its parameter list is invisible here.
  return fn ? fn.parameters.length > 0 : true;
}


export function componentStem(fileName: string): string {
  const base = path.basename(fileName);
  const ext = path.extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}


export interface PropsBinding {
  type?: ts.Type;
  targetName?: string;
  // 1-based source line of the target's declaration.
  targetLine?: number;
  // Set only for a computed annotation: the one case where an empty schema is a failure.
  computedAnnotation?: string;
  // Threaded to typeToSchema so it can read which prop names the component's body references.
  fn?: ts.SignatureDeclaration;
  // A JS entry's sibling declaration outranks this binding (ADR 0004).
  viaTypeFallback?: boolean;
  // Another declaration in the file bound while the target did not; reported after the fallback.
  unboundTargetHijacked?: boolean;
  // Set when the measured file only re-exports the component another module declares.
  targetFile?: string;
  // The unresolved barrel hop: an empty props table is then a fact about the file.
  unresolvedReExport?: { barrel: string; specifier: string };
}


// A plain `interface Props` that yields nothing is honest; a computed annotation is not.
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


// Names the import the annotation reads: an empty schema is otherwise indistinguishable from
// a component with no props at all.
export function UNRESOLVED_ANNOTATION_MODULE_WARNING(
  fileName: string,
  targetName: string,
  annotation: string,
  modules: string[],
): string {
  const named = modules.map((module) => `"${module}"`).join(", ");
  return (
    `Warning: the props type ${annotation} for ${targetName} in ${fileName} reads ${named}, ` +
    "which resolves to no module on disk: the props declared there are missing from this run."
  );
}


// The import declaration a local alias came from, and the specifier it named.
function importedModuleSpecifier(symbol: ts.Symbol): ts.StringLiteralLike | undefined {
  for (const declaration of symbol.getDeclarations() ?? []) {
    let node: ts.Node | undefined = declaration;
    while (node) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        return node.moduleSpecifier;
      }
      node = node.parent;
    }
  }
  return undefined;
}


// A module that resolved has a symbol on its specifier; a missing named export is another story.
function unresolvedAnnotationModules(
  node: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
): string[] {
  if (!node) return [];
  const modules: string[] = [];
  const seen = new Set<string>();
  const consider = (name: ts.EntityName | ts.Node): void => {
    let head: ts.Node = name;
    while (ts.isQualifiedName(head)) head = head.left;
    if (ts.isPropertyAccessExpression(head)) head = head.expression;
    if (!ts.isIdentifier(head)) return;
    const symbol = checker.getSymbolAtLocation(head);
    if (!symbol || (symbol.flags & ts.SymbolFlags.Alias) === 0) return;
    const specifier = importedModuleSpecifier(symbol);
    if (!specifier || checker.getSymbolAtLocation(specifier) !== undefined) return;
    if (seen.has(specifier.text)) return;
    seen.add(specifier.text);
    modules.push(specifier.text);
  };
  const visit = (child: ts.Node): void => {
    if (ts.isTypeReferenceNode(child)) consider(child.typeName);
    else if (ts.isTypeQueryNode(child)) consider(child.exprName);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return modules;
}


// The `export`-inclusive start, 1-based, so a dry run points at the line a reader opens.
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


export function findComponentPropsType(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  explicitTarget?: string,
  sink?: (message: string) => void,
  hops = 0,
): PropsBinding {
  const candidates = collectComponentCandidates(sourceFile);
  const target = selectTargetCandidate(
    candidates,
    sourceFile.fileName,
    sourceFile.getFullText(),
    explicitTarget,
  );
  if (!target) {
    if (hops >= RE_EXPORT_HOPS) return {};
    const followed = followReExportedComponent(sourceFile, checker, explicitTarget, sink);
    if (followed === undefined) return {};
    if ("unresolved" in followed) return { unresolvedReExport: followed.unresolved };
    const binding = findComponentPropsType(followed.file, checker, followed.name, sink, hops + 1);
    return binding.targetName === undefined
      ? binding
      : { ...binding, targetFile: binding.targetFile ?? path.normalize(followed.file.fileName) };
  }

  const byName = new Map<string, ComponentCandidate>();
  for (const candidate of candidates) {
    if (!byName.has(candidate.name)) byName.set(candidate.name, candidate);
  }

  let bound = bindProps(target, checker, byName);

  // A props type that shares no key with the target's destructuring did not come from the target.
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

  const annotationNode = firstParameterTypeNode(target);
  const unresolvedModules = unresolvedAnnotationModules(annotationNode, checker);
  if (unresolvedModules.length > 0 && annotationNode) {
    emit(
      `${path.resolve(sourceFile.fileName)}::unresolved-annotation::${target.name}`,
      UNRESOLVED_ANNOTATION_MODULE_WARNING(
        path.normalize(sourceFile.fileName),
        target.name,
        annotationNode.getText(),
        unresolvedModules,
      ) + "\n",
      sink,
    );
  }
  const computedAnnotation = computedAnnotationText(annotationNode);
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

  // The caller reports this after the sibling declaration's turn; here it would misflag JS entries.
  if (expectsProps(target)) {
    const hijacker = candidates.some(
      (candidate) => candidate !== target && bindProps(candidate, checker, byName),
    );
    if (hijacker) return { ...context, unboundTargetHijacked: true };
  }

  return context;
}


// ADR 0004: forwardRef's wrapper supplies ref and key; a component's own `ref` declaration stays.
const REACT_AMBIENT_ATTRIBUTES = new Set(["ref", "key"]);


function isReactAmbientAttribute(symbol: ts.Symbol): boolean {
  if (!REACT_AMBIENT_ATTRIBUTES.has(symbol.getName())) return false;
  const declarations = symbol.getDeclarations();
  if (!declarations || declarations.length === 0) return true;
  return declarations.every((declaration) =>
    REACT_TYPE_PACKAGE.test(declaration.getSourceFile().fileName),
  );
}


export function looksLikePropsType(type: ts.Type, checker: ts.TypeChecker): boolean {
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
