import path from "node:path";
import ts from "typescript";
import { findProjectRoot, findWorkspaceRoot, resolveGoverningTsconfig } from "./model.js";

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


// The reader keeps quiet about a config it could not read, so the caller that
// asked prints the message once. Its sentence names the path this function
// already has, so the path is not repeated inside the detail.
function readFailureDetail(warnings: string[], configPath: string): string {
  const marker = `could not parse tsconfig at ${configPath}: `;
  const failure = warnings.find((warning) => warning.startsWith(marker));
  return failure ? failure.slice(marker.length) : (warnings[0] ?? "the config could not be read");
}


// The reader surfaces only the diagnostics the run discloses (a broken extends
// chain). An option declared with the wrong value type has warned here once per
// config since M24 and still does, read from the governing config's own
// compilerOptions without globbing the project's files a second time.
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
  // A malformed include/files key, or an invalid option inside an extends base,
  // never reaches convertCompilerOptionsFromJson. Parsing without globbing
  // surfaces it; 18003 only says the fixture has no input files.
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    { ...ts.sys, readDirectory: () => [] },
    path.dirname(configPath),
    undefined,
    configPath,
  );
  const other = parsed.errors.find((diagnostic) => diagnostic.code !== 18003);
  return other ? ts.flattenDiagnosticMessageText(other.messageText, " ") : undefined;
}


export function createCompilerOptions(absolutePath: string): ts.CompilerOptions {
  // M69: the same search the harness builds aliases from, so one config
  // governs both. The bound is the workspace root; a tree with no package.json
  // anywhere has no project model, and the walk keeps its old reach.
  // M109 (I1): through the shared reader, so a references-only root hands
  // extraction the referenced config that covers this file, which is the
  // config the harness aliases and the dev server resolve from.
  const startDir = path.dirname(absolutePath);
  const memberRoot = findProjectRoot(startDir);
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
    // A .jsx target is outside the program without this, so extraction has no
    // source file to read and reports the component as unparsable.
    allowJs: true,
  };

  if (governing.nearestConfigPath && !tsconfigPath) {
    // B2: a config that could not be read keeps its one warning, and
    // extraction continues on the defaults above.
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
      // The measured file is named by the user: a project that excludes
      // JavaScript from type checking still gets its .jsx component read.
      allowJs: true,
    };
  }

  return compilerOptions;
}
