import ts from "typescript";
import path from "node:path";

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
}

export interface ScalingPropMatch {
  schema: PropSchema;
  kind: "numeric" | "array";
  reason: string;
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

export async function extractProps(filePath: string): Promise<PropSchema[]> {
  const absolutePath = path.resolve(filePath);

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
    if (!configFile.error) {
      const parsed = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        path.dirname(tsconfigPath),
      );
      // Override resolution to Bundler — user components use extensionless imports
      compilerOptions = {
        ...parsed.options,
        skipLibCheck: true,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        module: ts.ModuleKind.ESNext,
      };
    }
  }

  const program = ts.createProgram([absolutePath], compilerOptions);
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(absolutePath);

  if (!sourceFile) {
    throw new Error(`Could not parse ${filePath}`);
  }

  const propsType = findComponentPropsType(sourceFile, checker);
  if (!propsType) {
    return [];
  }

  return typeToSchema(propsType, checker);
}

function findComponentPropsType(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  let propsType: ts.Type | undefined;

  ts.forEachChild(sourceFile, (node) => {
    if (propsType) return;

    // function Component(props: Props) — PascalCase name required (React convention)
    if (ts.isFunctionDeclaration(node) && node.name && /^[A-Z]/.test(node.name.text) && node.parameters.length > 0) {
      const param = node.parameters[0];
      const type = checker.getTypeAtLocation(param);
      if (looksLikePropsType(type, checker)) {
        propsType = type;
      }
    }

    // class Counter extends React.Component<Props>
    if (ts.isClassDeclaration(node) && node.name && node.heritageClauses) {
      for (const clause of node.heritageClauses) {
        for (const typeExpr of clause.types) {
          const typeArgs = typeExpr.typeArguments;
          if (typeArgs && typeArgs.length > 0) {
            const type = checker.getTypeFromTypeNode(typeArgs[0]);
            if (looksLikePropsType(type, checker)) {
              propsType = type;
            }
          }
        }
      }
    }

    // export const Component = (props: Props) => ...
    // export const Component = React.forwardRef<Ref, Props>((props, ref) => ...)
    // export const Component = React.memo(InnerComponent)
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!decl.initializer) continue;

        const fn = extractFunctionFromInitializer(decl.initializer);
        if (fn && fn.parameters.length > 0) {
          const type = checker.getTypeAtLocation(fn.parameters[0]);
          if (looksLikePropsType(type, checker)) {
            propsType = type;
          }
        }
      }
    }
  });

  return propsType;
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

function typeToSchema(type: ts.Type, checker: ts.TypeChecker): PropSchema[] {
  const schemas: PropSchema[] = [];

  for (const prop of type.getProperties()) {
    const name = prop.getName();
    const decl = prop.getDeclarations()?.[0];
    if (!decl) continue;

    const propType = checker.getTypeOfSymbolAtLocation(prop, decl);
    const required = !(prop.flags & ts.SymbolFlags.Optional);

    const schema = classifyType(name, propType, required, checker);
    schemas.push(schema);
  }

  return schemas;
}

function classifyType(
  name: string,
  type: ts.Type,
  required: boolean,
  checker: ts.TypeChecker,
): PropSchema {
  // For union types, strip undefined members and work with what remains
  const nonUndefinedTypes = type.isUnion()
    ? type.types.filter((t) => !(t.flags & ts.TypeFlags.Undefined))
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

  // Array
  if (checker.isArrayType(classifyTarget)) {
    return { name, kind: "array", required, values: [[], ["item"]] };
  }

  // Object
  if (classifyTarget.flags & ts.TypeFlags.Object) {
    return { name, kind: "object", required, values: [{}] };
  }

  return { name, kind: "unknown", required, values: [] };
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

export async function extractExports(filePath: string): Promise<import("./composition.js").ExportInfo[]> {
  const absolutePath = path.resolve(filePath);
  const program = ts.createProgram([absolutePath], createCompilerOptions(absolutePath));
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(absolutePath);
  if (!sourceFile) return [];

  const exports: import("./composition.js").ExportInfo[] = [];
  const seen = new Set<string>();

  ts.forEachChild(sourceFile, (node) => {
    if (!hasExportModifier(node)) return;

    const isDefault = hasDefaultModifier(node);

    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.text;
      if (isComponentName(name) && !seen.has(name)) {
        seen.add(name);
        exports.push({ name, isDefault });
      }
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const name = node.name.text;
      if (isComponentName(name) && !seen.has(name)) {
        seen.add(name);
        exports.push({ name, isDefault });
      }
    }

    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const name = decl.name.text;
          if (isComponentName(name) && !seen.has(name)) {
            seen.add(name);
            exports.push({ name, isDefault });
          }
        }
      }
    }
  });

  return exports;
}

export async function extractAllProps(filePath: string): Promise<Map<string, PropSchema[]>> {
  const absolutePath = path.resolve(filePath);
  const options = createCompilerOptions(absolutePath);
  const program = ts.createProgram([absolutePath], options);
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
    if (!configFile.error) {
      const parsed = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        path.dirname(tsconfigPath),
      );
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
