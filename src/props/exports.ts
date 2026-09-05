import path from "node:path";
import ts from "typescript";
import { isVueFile, loadVueCompiler, createCompilerOptions } from "../project/index.js";
import { identifierBehind, looksLikePropsType, selectMeasuredExport } from "./candidates.js";
import { typeToSchema } from "./classify.js";
import { createCachedProgram } from "./program.js";
import type { ExportInfo, PropSchema } from "./schema.js";
import { createVueScripts, vueEntryScript, type VirtualScripts } from "./vue.js";

// An alias with no declaration is an unresolved specifier: a filesystem fact, not a failed read.
type ReExportTarget =
  | { file: ts.SourceFile; name: string | undefined }
  | { unresolved: { barrel: string; specifier: string } };


function moduleSpecifierFor(sourceFile: ts.SourceFile, name: string): string | undefined {
  // One `export *` can be named as the cause; with two, naming either would be a guess.
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
    // A throwing checker is a different cause from an unresolved specifier; the run says which.
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


// scanExports sees no name in `export { default } from` or `export *`; export symbols carry both.
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


// `default` is a slot rather than an identifier, so the declaring file selects its own export.
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


// The bound stops a cycle of two files re-exporting each other.
export const RE_EXPORT_HOPS = 4;


// Only a top-level match is trusted: a nested scope could bind the same name.
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
  // An assertion is erased at runtime; unwrapped first so it composes with the cases below.
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

  // Followed so sourceReferencedPropNames sees the implementation body; bounded against a cycle.
  if (ts.isIdentifier(node) && depth < 5) {
    const target = findTopLevelVariableInitializer(node);
    if (target) return extractFunctionFromInitializer(target, depth + 1);
  }

  return undefined;
}


// Parse-only: no type checker, so a barrel's exports read without binding the program.
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
    if (ts.isExportAssignment(node)) {
      // `memo(forwardRef(Button))` names Button; recording only a bare identifier would lose it.
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


// The file set whose contents identify the component for fingerprinting.
export async function projectSourceFiles(filePath: string): Promise<string[]> {
  const absolutePath = path.resolve(filePath);
  const files: string[] = [];

  // A virtual `<x>.vue.ts` collapses back to `<x>.vue`; nothing can hash a file with no bytes.
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
