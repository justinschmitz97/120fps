import path from "node:path";
import ts from "typescript";
import { isVueFile, loadVueCompiler } from "../project/index.js";
import { identifierBehind, looksLikePropsType, selectMeasuredExport } from "./candidates.js";
import { typeToSchema } from "./classify.js";
import { createCachedProgram, createCompilerOptions } from "./program.js";
import type { ExportInfo, PropSchema } from "./schema.js";
import { createVueScripts, vueEntryScript, type VirtualScripts } from "./vue.js";

// M114 B4/B5 (gutenberg-F2, react-spectrum-F3): the module a barrel's exported
// binding is declared in. `export { X } from "./component"` and
// `import { X } from "./component"; export { X };` both reach it through the
// checker's alias, so one lookup serves both spellings. An alias whose target
// has no declaration is a specifier that did not resolve, which is a fact about
// the filesystem, not a failed extraction.
type ReExportTarget =
  | { file: ts.SourceFile; name: string | undefined }
  | { unresolved: { barrel: string; specifier: string } };


function moduleSpecifierFor(sourceFile: ts.SourceFile, name: string): string | undefined {
  // M114 (review B-minor): a bare `export * from` specifier stands in for a
  // name it never matched. It is the only candidate when the file has exactly
  // one star; with two, naming either as the cause would be a guess.
  let starSpecifier: string | undefined;
  let starCount = 0;
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const clause = statement.exportClause;
      if (!clause) {
        starSpecifier ??= statement.moduleSpecifier.text;
        starCount += 1;
        continue;
      }
      if (!ts.isNamedExports(clause)) continue;
      for (const spec of clause.elements) {
        if (spec.name.text === name) return statement.moduleSpecifier.text;
      }
      continue;
    }
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.importClause
    ) {
      const named = statement.importClause.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const spec of named.elements) {
          if (spec.name.text === name) return statement.moduleSpecifier.text;
        }
      }
      if (statement.importClause.name?.text === name) return statement.moduleSpecifier.text;
    }
  }
  return starCount === 1 ? starSpecifier : undefined;
}


function aliasTargetOf(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  sink?: (message: string) => void,
): ts.Symbol | undefined {
  if (!(symbol.flags & ts.SymbolFlags.Alias)) return symbol;
  try {
    return checker.getAliasedSymbol(symbol);
  } catch (error) {
    // M114 (review B-minor): the checker throwing is a different cause from a
    // specifier the filesystem never resolved, so the run says which one it hit.
    const reason = error instanceof Error ? error.message : String(error);
    sink?.(`re-export of ${symbol.getName()}: the type checker could not follow the alias (${reason})`);
    return undefined;
  }
}


const COMPONENT_DECLARATION_NAME = /^[A-Z]/;


function isValueDeclaration(declaration: ts.Declaration): boolean {
  return (
    ts.isFunctionDeclaration(declaration) ||
    ts.isClassDeclaration(declaration) ||
    ts.isVariableDeclaration(declaration) ||
    ts.isExportAssignment(declaration)
  );
}


// M114 B4/B5: `export { default } from "./component"` and `export * from
// "./component"` name no PascalCase binding in the barrel's own text, so
// `scanExports` yields nothing and the walk stopped at a barrel the filesystem
// resolves fine. The module's export symbols carry both spellings.
function fallbackExportSymbol(
  moduleExports: ts.Symbol[],
  checker: ts.TypeChecker,
  sink?: (message: string) => void,
): ts.Symbol | undefined {
  const byDefault = moduleExports.find((symbol) => symbol.name === "default");
  if (byDefault) return aliasTargetOf(byDefault, checker, sink);
  for (const symbol of moduleExports) {
    if (!COMPONENT_DECLARATION_NAME.test(symbol.name)) continue;
    const aliased = aliasTargetOf(symbol, checker, sink);
    const declaration = aliased?.getDeclarations()?.[0];
    if (declaration && isValueDeclaration(declaration)) return aliased;
  }
  return undefined;
}


// The name the declaring module knows the component by. `default` is a slot,
// not an identifier, so the declaring file selects its own export instead.
function declaredNameOf(aliased: ts.Symbol, declaration: ts.Declaration): string | undefined {
  const declared = (declaration as ts.Declaration & { name?: ts.Node }).name;
  if (declared && ts.isIdentifier(declared)) return declared.text;
  const name = aliased.getName();
  return name === "default" ? undefined : name;
}


function declaredElsewhere(
  aliased: ts.Symbol | undefined,
  sourceFile: ts.SourceFile,
): ReExportTarget | undefined {
  const declaration = aliased?.getDeclarations()?.[0];
  const declaringFile = declaration?.getSourceFile();
  if (!aliased || !declaration || !declaringFile) return undefined;
  if (declaringFile.fileName === sourceFile.fileName) return undefined;
  return { file: declaringFile, name: declaredNameOf(aliased, declaration) };
}


export function followReExportedComponent(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  explicitTarget?: string,
  sink?: (message: string) => void,
): ReExportTarget | undefined {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  const moduleExports = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];
  const name =
    explicitTarget ??
    selectMeasuredExport(
      scanExports(sourceFile.getFullText(), sourceFile.fileName),
      sourceFile.fileName,
    );

  if (name) {
    const exported = moduleExports.find((symbol) => symbol.name === name);
    const followed = exported
      ? declaredElsewhere(aliasTargetOf(exported, checker, sink), sourceFile)
      : undefined;
    if (followed) return followed;
    const specifier = moduleSpecifierFor(sourceFile, name);
    if (specifier === undefined) return undefined;
    return { unresolved: { barrel: path.normalize(sourceFile.fileName), specifier } };
  }

  const followed = declaredElsewhere(fallbackExportSymbol(moduleExports, checker, sink), sourceFile);
  if (followed) return followed;
  const specifier = moduleSpecifierFor(sourceFile, "default");
  if (specifier === undefined) return undefined;
  return { unresolved: { barrel: path.normalize(sourceFile.fileName), specifier } };
}


// A barrel of barrels still resolves in a bounded number of hops; the bound
// stops a cycle of two files re-exporting each other.
export const RE_EXPORT_HOPS = 4;


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


export function extractFunctionFromInitializer(
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
      // M114 B1 / I9 (logto-F1): `export default forwardRef(Button)` and
      // `memo(forwardRef(Button))` name `Button` as the default. Recording only
      // a bare identifier dropped the default entirely, so `selectMeasuredExport`
      // fell through to the first non-Provider export and the header named a
      // sibling while the props table described the wrapped component.
      const identifier = !node.isExportEquals ? identifierBehind(node.expression) : undefined;
      if (identifier) add(identifier.text, true);
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


export function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}


export function hasDefaultModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
}


export function isComponentName(name: string): boolean {
  if (!/^[A-Z]/.test(name)) return false;
  if (/^[A-Z_][A-Z0-9_]*$/.test(name)) return false;
  return true;
}
