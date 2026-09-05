import path from "node:path";
import ts from "typescript";
import { findProjectRoot, findWorkspaceRoot, resolveGoverningTsconfig } from "./model.js";

// One warning per tsconfig path per process.
const warnedTsconfigPaths = new Set<string>();


function warnTsconfigOnce(configPath: string, detail: string): void {
  if (warnedTsconfigPaths.has(configPath)) return;
  warnedTsconfigPaths.add(configPath);
  process.stderr.write(`Warning: problem reading tsconfig at ${configPath}: ${detail}\n`);
}


// The same options prop extraction uses, so preflight follows the measured graph's paths.
export function projectCompilerOptions(absolutePath: string): ts.CompilerOptions {
  return createCompilerOptions(path.resolve(absolutePath));
}


// The caller's sentence already names configPath, so the detail drops the marker prefix.
function readFailureDetail(warnings: string[], configPath: string): string {
  const marker = `could not parse tsconfig at ${configPath}: `;
  const failure = warnings.find((warning) => warning.startsWith(marker));
  return failure ? failure.slice(marker.length) : (warnings[0] ?? "the config could not be read");
}


// The shared reader surfaces only extends breakage; a wrong-typed option is diagnosed here.
function declaredOptionDiagnostic(configPath: string): string | undefined {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const raw = configFile.config as { compilerOptions?: unknown } | undefined;
  const declared = raw?.compilerOptions;
  if (configFile.error || declared === null || typeof declared !== "object") return undefined;
  const converted = ts.convertCompilerOptionsFromJson(
    declared,
    path.dirname(configPath),
    configPath,
  );
  if (converted.errors.length > 0) {
    return ts.flattenDiagnosticMessageText(converted.errors[0].messageText, " ");
  }
  // convertCompilerOptionsFromJson never sees a bad include/files key or an extends option.
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    { ...ts.sys, readDirectory: () => [] },
    path.dirname(configPath),
    undefined,
    configPath,
  );
  // 18003 only says the config matched no input files, which is normal.
  const other = parsed.errors.find((diagnostic) => diagnostic.code !== 18003);
  return other ? ts.flattenDiagnosticMessageText(other.messageText, " ") : undefined;
}


export function createCompilerOptions(absolutePath: string): ts.CompilerOptions {
  const startDir = path.dirname(absolutePath);
  const memberRoot = findProjectRoot(startDir);
  // The shared reader, so extraction and the harness aliases resolve from the same config.
  const governing = resolveGoverningTsconfig(
    absolutePath,
    memberRoot === undefined ? undefined : findWorkspaceRoot(memberRoot),
  );
  const tsconfigPath = governing.configPath;

  let compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
    skipLibCheck: true,
    // Without allowJs a .jsx target is outside the program and reads as unparsable.
    allowJs: true,
  };

  if (governing.nearestConfigPath && !tsconfigPath) {
    // An unreadable config is not fatal: extraction continues on the defaults above.
    warnTsconfigOnce(
      governing.nearestConfigPath,
      readFailureDetail(governing.warnings, governing.nearestConfigPath),
    );
  } else if (tsconfigPath) {
    if (!warnedTsconfigPaths.has(tsconfigPath)) {
      const optionDetail = declaredOptionDiagnostic(tsconfigPath);
      if (optionDetail) warnTsconfigOnce(tsconfigPath, optionDetail);
    }
    // Override resolution to Bundler: user components use extensionless imports
    compilerOptions = {
      ...governing.options,
      skipLibCheck: true,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
      // The user named the file, so a project that type-checks no JavaScript still reads .jsx.
      allowJs: true,
    };
  }

  return compilerOptions;
}
