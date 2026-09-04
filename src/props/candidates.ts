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
import { literalValue } from "./presets.js";
import type { ExportInfo, PropSchema } from "./schema.js";
import { REACT_TYPE_PACKAGE } from "./synthesize.js";

// One component declaration per entry, in source order, with the export
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


// The declared component's props, read the way an importer reads them: the
// exported symbol's first call signature's first parameter.
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
  // The function the type came from, when one was reachable: the source of
  // the destructured parameter names the self-consistency guard compares.
  fn?: ts.SignatureDeclaration;
  // Set only by the last resort in `bindProps` — the call signatures of
  // the binding's own type, rather than an annotated parameter. A JS entry's
  // sibling declaration outranks this one (ADR 0004).
  viaTypeFallback?: boolean;
}


const IDENTIFIER_HOPS = 8;


// The one stem rule. Shared with `detectComponentExport` so the harness
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


// Selection order: default export > file-stem match after dropping
// non-alphanumerics > first exported component > first declaration. The last
// step only applies to files that export nothing at all.
function selectTargetCandidate(
  candidates: ComponentCandidate[],
  fileName: string,
  sourceText: string,
  explicitTarget?: string,
): ComponentCandidate | undefined {
  // `<file>#Export` names the component the harness will import, so the
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

    // Export order and declaration order can diverge — heroui's
    // `export { BadgeRoot, BadgeLabel, BadgeAnchor }` puts `BadgeRoot` first
    // in `scanExports`'s order, while declaration order puts `BadgeAnchor`
    // first. `detectComponentExport` reads `scanExports`'s order, so this
    // fallback reads the same order: one selection function over one export
    // list keeps the two picks from diverging.
    const measured = selectMeasuredExport(scanExports(sourceText, fileName), fileName);
    const measuredMatch = measured
      ? exported.find((c) => [c.name, ...c.aliases].includes(measured))
      : undefined;
    return measuredMatch ?? exported[0];
  }

  return candidates[0];
}


// The export a run measures, from one list of exports. `scanExports`
// lives in this file and `detectComponentExport` (src/harness/exports.ts)
// imports from here, so the harness's own pick routes through this same
// order (a `Provider` rule is the third clause).
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


// The literal defaults a destructured first parameter
// declares (`{ loading = false, color = "primary" }`). A non-literal default
// (a call, a variable) is not recorded rather than guessed at.
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


// The pre-hooks convention, `Component.defaultProps = {...}` at the
// top level of the component's own file. Parse-only, same shallow tradeoff
// `detectOptionsApiProps` accepts.
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


// The default is recorded on the schema. `reorderValues` matches Vue's
// `withDefaults` behavior: the declared default leads the pool. A React
// default is disclosed without changing which values are measured in which
// order.
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


// Names bound out of a destructured first parameter, renames resolved to the
// source property and rest elements ignored.
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
  // The target's first-parameter annotation, when it is a computed type: the
  // only case where an empty schema is a resolution failure rather than a fact.
  computedAnnotation?: string;
  // The function the props type was bound to, when one was reachable —
  // threaded through so `typeToSchema` can read which prop names the
  // component's own body references by name.
  fn?: ts.SignatureDeclaration;
  // The type came from the binding's own call signatures, the last resort
  // in `bindProps`. A JS entry's sibling declaration outranks it (ADR 0004).
  viaTypeFallback?: boolean;
  // Nothing bound to the measured target while another declaration in the
  // same file did bind. Reported only once the declaration fallback has also
  // come up empty.
  unboundTargetHijacked?: boolean;
  // The module the binding was read from, when the
  // measured file only re-exports the component another module declares.
  targetFile?: string;
  // The barrel and the specifier that did not
  // resolve. A cause the filesystem decides, so no props table is a fact about
  // this file rather than a failed extraction.
  unresolvedReExport?: { barrel: string; specifier: string };
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

  // Reported by the caller, after the sibling declaration has had its turn:
  // emitting here would flag every MUI `.js` component whose declaration
  // resolves all sixteen props as unresolvable.
  if (expectsProps(target)) {
    const hijacker = candidates.some(
      (candidate) => candidate !== target && bindProps(candidate, checker, byName),
    );
    if (hijacker) return { ...context, unboundTargetHijacked: true };
  }

  return context;
}


// ADR 0004: `React.forwardRef<T, P = {}>` with an unannotated render
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
