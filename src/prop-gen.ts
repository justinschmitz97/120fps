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

    // function Component(props: Props)
    if (ts.isFunctionDeclaration(node) && node.name && node.parameters.length > 0) {
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

  // Destructured object parameter — check it has named members
  const typeStr = checker.typeToString(type);
  // Skip primitive types
  if (["string", "number", "boolean", "undefined", "null"].includes(typeStr)) {
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
