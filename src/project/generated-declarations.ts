import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { findWorkspaceRoot, isPackageAvailable } from "./model.js";
import { toPosix } from "../shared/index.js";

// A name the project's own tooling wrote down, with the module it comes from.
export interface DeclaredName {
  name: string;
  // The specifier exactly as the generated file wrote it.
  module: string;
  // The export the name binds to; an SFC binds `default`.
  exportName: string;
}

// A name whose module was found: `target` is an absolute file, or the specifier to pass through.
export interface ResolvedName {
  name: string;
  target: string;
  targetIsFile: boolean;
  exportName: string;
}

export interface ResolvedDeclarationMap {
  file: string;
  names: ResolvedName[];
  // Names whose module is not on disk, so nothing can be imported for them.
  skipped: string[];
  // Names whose module lives inside a dependency; see DEFERRED_COMPONENTS_WARNING.
  deferred: string[];
}

// The paths the two generator plugins and Nuxt write, in the order a project is searched.
export const COMPONENT_MAP_FILES: readonly string[] = [
  "components.d.ts",
  "src/components.d.ts",
  "types/components.d.ts",
  "src/types/components.d.ts",
  "app/components.d.ts",
  ".nuxt/components.d.ts",
];

export const AUTO_IMPORT_MAP_FILES: readonly string[] = [
  "auto-imports.d.ts",
  "src/auto-imports.d.ts",
  "types/auto-imports.d.ts",
  "src/types/auto-imports.d.ts",
  "app/auto-imports.d.ts",
];

const SKIPPED_NAMES_SHOWN = 5;

// Every word in a file, so a cheap set test decides whether the parser is worth running.
const WORD = /[A-Za-z_$][\w$]*/g;

export function GENERATED_COMPONENTS_DISCLOSURE(file: string, count: number): string {
  return (
    `${file} maps ${count} component name${count === 1 ? "" : "s"} to modules on disk; the ` +
    "harness registers them on the app before it mounts, so a tag the project resolves without " +
    "an import resolves here too."
  );
}

export function GENERATED_MAP_SKIPPED_WARNING(file: string, skipped: readonly string[]): string {
  const shown = skipped.slice(0, SKIPPED_NAMES_SHOWN);
  const rest = skipped.length - shown.length;
  const tail = rest > 0 ? `, and ${rest} more` : "";
  return (
    `${file}: ${skipped.length} entr${skipped.length === 1 ? "y names a module" : "ies name modules"} ` +
    `that is not on disk, so ${skipped.length === 1 ? "it was" : "they were"} skipped ` +
    `(${shown.join(", ")}${tail}). Run the project's own build or type generation to refresh it.`
  );
}

// A dependency's own component resolves through the framework runtime the harness does not run.
export function DEFERRED_COMPONENTS_WARNING(
  file: string,
  used: readonly string[],
  total: number,
): string {
  const rest = total - used.length;
  const tail =
    rest > 0 ? ` ${rest} further entr${rest === 1 ? "y is" : "ies are"} in the same class.` : "";
  return (
    `${file} maps ${used.join(", ")}, which this component's source references, to modules inside ` +
    "a dependency. The harness registers the project's own components only, because a dependency's " +
    "component commonly needs an application runtime it does not provide (a router instance, " +
    `Nuxt's \`#imports\`), so those tags render as nothing.${tail}`
  );
}

// A tag written as <UCarousel> or <u-carousel> names the same registered component.
export function kebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

export function deferredComponentsUsedBy(source: string, deferred: readonly string[]): string[] {
  const words = new Set(source.match(WORD) ?? []);
  const tags = new Set(
    (source.match(/<\/?[a-z][\w-]*/g) ?? []).map((tag) => tag.replace(/^<\/?/, "")),
  );
  return deferred.filter((name) => words.has(name) || tags.has(kebabCase(name)));
}

export function AUTO_IMPORT_DISCLOSURE(file: string, count: number): string {
  return (
    `${file} maps ${count} auto-imported identifier${count === 1 ? "" : "s"}; the harness ` +
    "prepends the import to a module in this component's own graph that references one without " +
    "importing it."
  );
}

// Text only: no program, no project code, and an unrecognised line costs nothing but itself.
export function parseDeclarationMap(source: string, fileName: string): DeclaredName[] {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found: DeclaredName[] = [];
  const seen = new Set<string>();
  const record = (name: string, type: ts.TypeNode | undefined): void => {
    if (!type || seen.has(name)) return;
    const entry = readTypeofImport(type);
    if (!entry) return;
    seen.add(name);
    found.push({ name, module: entry.module, exportName: entry.exportName });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) record(declaration.name.text, declaration.type);
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      for (const member of node.members) {
        if (!ts.isPropertySignature(member)) continue;
        const key = propertyName(member.name);
        if (key) record(key, member.type);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return undefined;
}

// `typeof import('m').Name`, `typeof import('m')['Name']`, and the same inside a wrapper generic.
function readTypeofImport(type: ts.TypeNode): { module: string; exportName: string } | undefined {
  // `(typeof import("m"))["Name"]` is the same table entry as the unparenthesised form.
  if (ts.isParenthesizedTypeNode(type)) return readTypeofImport(type.type);
  if (ts.isIndexedAccessTypeNode(type)) {
    const object = readTypeofImport(type.objectType);
    if (!object) return undefined;
    const index = type.indexType;
    if (ts.isLiteralTypeNode(index) && ts.isStringLiteral(index.literal)) {
      return { module: object.module, exportName: index.literal.text };
    }
    return object;
  }
  if (ts.isImportTypeNode(type) && type.isTypeOf) {
    const argument = type.argument;
    if (!ts.isLiteralTypeNode(argument) || !ts.isStringLiteral(argument.literal)) return undefined;
    const qualifier = type.qualifier;
    const exportName = qualifier && ts.isIdentifier(qualifier) ? qualifier.text : "default";
    return { module: argument.literal.text, exportName };
  }
  if (ts.isTypeReferenceNode(type)) {
    for (const argument of type.typeArguments ?? []) {
      const nested = readTypeofImport(argument);
      if (nested) return nested;
    }
  }
  return undefined;
}

// What the harness itself compiles; a map entry pointing anywhere else is not resolvable here.
const MODULE_EXTENSIONS = [".vue", ".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".d.ts"];

function resolveDeclaredFile(specifier: string, fromDir: string): string | undefined {
  const base = path.resolve(fromDir, specifier);
  const candidates = [
    ...(MODULE_EXTENSIONS.includes(path.extname(base)) ? [base] : []),
    ...MODULE_EXTENSIONS.map((extension) => base + extension),
    ...MODULE_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // A candidate that is not on disk is simply not the answer.
    }
  }
  return undefined;
}

// `@scope/name/sub` and `name/sub` both carry the package the install has to hold.
function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const mapCache = new Map<string, { mtimeMs: number; names: DeclaredName[] }>();

export function resetGeneratedDeclarationCache(): void {
  mapCache.clear();
}

function readDeclarationFile(file: string): DeclaredName[] {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return [];
  }
  const cached = mapCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.names;
  let names: DeclaredName[] = [];
  try {
    names = parseDeclarationMap(fs.readFileSync(file, "utf8"), file);
  } catch {
    names = [];
  }
  mapCache.set(file, { mtimeMs, names });
  return names;
}

export function findDeclarationMap(
  projectRoot: string,
  candidates: readonly string[],
): string | undefined {
  for (const candidate of candidates) {
    const absolute = path.join(projectRoot, ...candidate.split("/"));
    try {
      if (fs.statSync(absolute).isFile()) return absolute;
    } catch {
      // Not this one.
    }
  }
  return undefined;
}

// A file the project itself owns: under its root and outside every dependency directory.
export function isProjectSourceFile(target: string, projectRoot: string): boolean {
  const relative = path.relative(path.resolve(projectRoot), path.resolve(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  return !toPosix(relative).split("/").includes("node_modules");
}

function readDeclarationMap(
  projectRoot: string,
  workspaceRoot: string,
  candidates: readonly string[],
  projectSourceOnly = false,
): ResolvedDeclarationMap | undefined {
  const file = findDeclarationMap(projectRoot, candidates);
  if (!file) return undefined;
  const declared = readDeclarationFile(file);
  if (declared.length === 0) return undefined;
  const fromDir = path.dirname(file);
  const names: ResolvedName[] = [];
  const skipped: string[] = [];
  const deferred: string[] = [];
  for (const entry of declared) {
    if (entry.module.startsWith(".")) {
      const target = resolveDeclaredFile(entry.module, fromDir);
      if (!target) skipped.push(entry.name);
      else if (projectSourceOnly && !isProjectSourceFile(target, projectRoot)) {
        deferred.push(entry.name);
      } else names.push({ ...entry, target, targetIsFile: true });
      continue;
    }
    if (projectSourceOnly) {
      deferred.push(entry.name);
      continue;
    }
    if (isPackageAvailable(packageNameOf(entry.module), projectRoot, workspaceRoot)) {
      names.push({ ...entry, target: entry.module, targetIsFile: false });
    } else {
      skipped.push(entry.name);
    }
  }
  return { file, names, skipped, deferred };
}

export function readComponentDeclarationMap(
  projectRoot: string,
  workspaceRoot: string = findWorkspaceRoot(projectRoot),
): ResolvedDeclarationMap | undefined {
  return readDeclarationMap(projectRoot, workspaceRoot, COMPONENT_MAP_FILES, true);
}

export function readAutoImportDeclarationMap(
  projectRoot: string,
  workspaceRoot: string = findWorkspaceRoot(projectRoot),
): ResolvedDeclarationMap | undefined {
  return readDeclarationMap(projectRoot, workspaceRoot, AUTO_IMPORT_MAP_FILES);
}

// What a mount abort quotes when it names an identifier nothing defined.
export function autoImportMapEvidence(
  projectRoot: string,
): { autoImportMap: { file: string; names: string[] } } | undefined {
  const map = readAutoImportDeclarationMap(projectRoot);
  if (!map) return undefined;
  return { autoImportMap: { file: map.file, names: map.names.map((entry) => entry.name) } };
}

function scriptKindFor(file: string): ts.ScriptKind {
  const extension = path.extname(file).toLowerCase();
  return extension === ".tsx" || extension === ".jsx" || extension === ".js" || extension === ".mjs"
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
}

function collectBoundNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) collectBoundNames(element.name, into);
  }
}

// A reference in value position: never a member name, a key, a declaration or a type.
function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
  if (ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false;
  if (ts.isJsxAttribute(parent) && parent.name === node) return false;
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;
  if (ts.isMethodSignature(parent) || ts.isPropertySignature(parent)) return false;
  if (ts.isTypeNode(parent) || ts.isTypeParameterDeclaration(parent)) return false;
  if (ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent)) return false;
  const named = parent as ts.NamedDeclaration;
  return named.name !== node;
}

// Every identifier the module reads and nothing in the module binds, at any scope.
export function freeIdentifiers(source: string, fileName: string): Set<string> {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fileName),
  );
  const bound = new Set<string>();
  const referenced = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
      collectBoundNames(node.name as ts.BindingName, bound);
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name !== undefined
    ) {
      bound.add(node.name.text);
    } else if (ts.isImportClause(node) && node.name) {
      bound.add(node.name.text);
    } else if (ts.isNamespaceImport(node) || ts.isImportSpecifier(node)) {
      bound.add(node.name.text);
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      collectBoundNames(node.variableDeclaration.name, bound);
    } else if (ts.isIdentifier(node) && isValueReference(node)) {
      referenced.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  for (const name of bound) referenced.delete(name);
  return referenced;
}

function importSpecifierFor(entry: ResolvedName, fromFile: string): string {
  if (!entry.targetIsFile) return entry.target;
  const relative = toPosix(path.relative(path.dirname(fromFile), entry.target));
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function importStatement(entry: ResolvedName, fromFile: string): string {
  const from = JSON.stringify(importSpecifierFor(entry, fromFile));
  if (entry.exportName === "default") return `import ${entry.name} from ${from};`;
  if (entry.exportName === entry.name) return `import { ${entry.name} } from ${from};`;
  return `import { ${entry.exportName} as ${entry.name} } from ${from};`;
}

export function autoImportInjection(
  source: string,
  fileName: string,
  map: ResolvedDeclarationMap,
): { code: string; supplied: string[] } | undefined {
  const known = new Map(map.names.map((entry) => [entry.name, entry]));
  if (known.size === 0) return undefined;
  const words = source.match(WORD);
  if (!words || !words.some((word) => known.has(word))) return undefined;
  const file = stripModuleQuery(fileName);
  const free = freeIdentifiers(source, file);
  const supplied = [...free].filter((name) => known.has(name)).sort();
  if (supplied.length === 0) return undefined;
  // One line, so every line number the browser reports still points at its own source line.
  const prologue = supplied.map((name) => importStatement(known.get(name)!, file)).join(" ");
  return { code: `${prologue} ${source}`, supplied };
}

function stripModuleQuery(id: string): string {
  const query = id.indexOf("?");
  return query === -1 ? id : id.slice(0, query);
}

const TRANSFORMABLE_EXTENSIONS = new Set([".vue", ".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"]);

// The measured component's own graph: the project's source, never a dependency or the harness.
export function isAutoImportTarget(id: string, projectRoot: string, harnessDir?: string): boolean {
  if (id.includes("\0")) return false;
  const file = stripModuleQuery(id);
  if (!TRANSFORMABLE_EXTENSIONS.has(path.extname(file).toLowerCase())) return false;
  const query = id.slice(file.length);
  const blockType = /[?&]type=([a-z]+)/.exec(query)?.[1];
  if (blockType !== undefined && blockType !== "script") return false;
  if (!isProjectSourceFile(file, projectRoot)) return false;
  if (harnessDir) {
    const inHarness = path.relative(path.resolve(harnessDir), path.resolve(file));
    if (!inHarness.startsWith("..") && !path.isAbsolute(inHarness)) return false;
  }
  return true;
}

export interface AutoImportPlugin {
  name: string;
  transform(code: string, id: string): { code: string; map: null } | undefined;
}

// The harness's own plugin: it reads the map as data and executes nothing of the project's.
export function autoImportTransformPlugin(input: {
  projectRoot: string;
  map: ResolvedDeclarationMap;
  harnessDir?: string;
}): AutoImportPlugin {
  const { projectRoot, map, harnessDir } = input;
  return {
    name: "120fps:auto-imports",
    transform(code: string, id: string) {
      if (!isAutoImportTarget(id, projectRoot, harnessDir)) return undefined;
      const injected = autoImportInjection(code, id, map);
      if (!injected) return undefined;
      return { code: injected.code, map: null };
    },
  };
}
