import path from "node:path";
import ts from "typescript";
import {
  findCompilerConfig,
  findProjectRoot,
  findWorkspaceRoot,
  resolveGoverningTsconfig,
} from "./model.js";
import { delegatesToReferences } from "./tsconfig-aliases.js";
import { pathKey } from "../shared/index.js";
import { unbuiltWorkspaceSiblingPaths } from "./workspace-source.js";

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


// Which files share one answer: the roots and the config that governs them.
interface OptionsScope {
  memberRoot: string | undefined;
  nearestConfigPath: string | undefined;
  // A references-only config answers per file, so those files cannot share a key.
  perFile: boolean;
}

const scopeByDirectory = new Map<string, OptionsScope>();
const optionsByScope = new Map<string, ts.CompilerOptions>();

// Both registers span a process, so a test worker must start from empty.
export function resetCompilerOptionsCache(): void {
  scopeByDirectory.clear();
  optionsByScope.clear();
}

function optionsScope(absolutePath: string): string {
  const startDir = path.dirname(absolutePath);
  const directoryKey = pathKey(startDir);
  let scope = scopeByDirectory.get(directoryKey);
  if (scope === undefined) {
    const memberRoot = findProjectRoot(startDir);
    const nearestConfigPath = findCompilerConfig(
      startDir,
      memberRoot === undefined ? undefined : findWorkspaceRoot(memberRoot),
    );
    scope = {
      memberRoot,
      nearestConfigPath,
      perFile: nearestConfigPath !== undefined && delegatesToReferences(nearestConfigPath),
    };
    scopeByDirectory.set(directoryKey, scope);
  }
  if (scope.perFile) return pathKey(absolutePath);
  return JSON.stringify([
    scope.memberRoot === undefined ? null : pathKey(scope.memberRoot),
    scope.nearestConfigPath === undefined ? null : pathKey(scope.nearestConfigPath),
  ]);
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
  const scope = optionsScope(absolutePath);
  const cached = optionsByScope.get(scope);
  if (cached !== undefined) return cached;
  const options = readCompilerOptions(absolutePath);
  optionsByScope.set(scope, options);
  return options;
}


function readCompilerOptions(absolutePath: string): ts.CompilerOptions {
  const startDir = path.dirname(absolutePath);
  const memberRoot = findProjectRoot(startDir);
  const workspaceRoot = memberRoot === undefined ? undefined : findWorkspaceRoot(memberRoot);
  // The shared reader, so extraction and the harness aliases resolve from the same config.
  const governing = resolveGoverningTsconfig(absolutePath, workspaceRoot);
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

  // An unbuilt sibling declares a dist/ nothing wrote; without this its types resolve to nothing.
  const siblingPaths =
    memberRoot === undefined || workspaceRoot === undefined
      ? undefined
      : unbuiltWorkspaceSiblingPaths(memberRoot, workspaceRoot);
  if (siblingPaths) {
    // The project's own keys win: a declared alias for the same name is the user's decision.
    compilerOptions = {
      ...compilerOptions,
      paths: { ...siblingPaths, ...(compilerOptions.paths ?? {}) },
    };
  }

  return compilerOptions;
}
