import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { installedPackageDir, isPackageDeclared, readProjectManifest } from "./model.js";

export const REACT_COMPILER_PACKAGE = "babel-plugin-react-compiler";

export const REACT_COMPILER_DISABLED_WARNING =
  "React Compiler is installed but disabled for this run; rerender costs will be higher than production.";

// The plugin defaults to React 19, so an undetectable major keeps the compiler off entirely.
export function reactCompilerTargetUnknownWarning(projectRoot: string): string {
  return (
    `the installed React version could not be read from ${projectRoot}, so the React Compiler ` +
    `target is unknown; measuring without the compiler transform.`
  );
}

export function reactCompilerResolutionWarning(projectRoot: string): string {
  return (
    `${REACT_COMPILER_PACKAGE} is declared but could not be resolved from ${projectRoot}; ` +
    `measuring without the compiler transform.`
  );
}

// Declared, never merely resolvable: the compiler rewrites the code that gets measured.
export function detectReactCompiler(projectRoot: string): boolean {
  return isPackageDeclared(REACT_COMPILER_PACKAGE, projectRoot);
}

// The package.json subpath can be hidden by an exports map; walking up cannot.
function readCompilerVersion(pluginPath: string): string | undefined {
  let dir = path.dirname(pluginPath);
  while (true) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(manifest, "utf-8"));
        if (pkg?.name !== REACT_COMPILER_PACKAGE) return undefined;
        return typeof pkg.version === "string" ? pkg.version : undefined;
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface ReactCompilerResolution {
  pluginPath?: string;
  version?: string;
}

// Resolved from the project so the compiler version matches what it ships.
export function resolveReactCompiler(projectRoot: string): ReactCompilerResolution {
  try {
    const projectRequire = createRequire(path.join(projectRoot, "/"));
    const pluginPath = projectRequire.resolve(REACT_COMPILER_PACKAGE);
    const version = readCompilerVersion(pluginPath);
    return { pluginPath, ...(version ? { version } : {}) };
  } catch {
    return {};
  }
}

export interface ReactCompilerState {
  detected: boolean;
  active: boolean;
  version?: string;
  pluginPath?: string;
  warning?: string;
  target?: ReactCompilerTarget;
  skipped?: { target: string; missingModule: string };
}

// At most one warning per state, so two notes can never both reach the report.
export function resolveReactCompilerState(
  projectRoot: string,
  requested: boolean | undefined,
): ReactCompilerState {
  const detected = detectReactCompiler(projectRoot);

  if (requested === false) {
    return {
      detected,
      active: false,
      ...(detected ? { warning: REACT_COMPILER_DISABLED_WARNING } : {}),
    };
  }
  if (requested === undefined && !detected) return { detected: false, active: false };

  const { pluginPath, version } = resolveReactCompiler(projectRoot);
  if (!pluginPath) {
    if (requested === true) {
      throw new Error(
        `${REACT_COMPILER_PACKAGE} not found in ${projectRoot}; install ${REACT_COMPILER_PACKAGE} ` +
          `in the project, or drop --react-compiler.`,
      );
    }
    return {
      detected,
      active: false,
      warning: reactCompilerResolutionWarning(projectRoot),
    };
  }
  const installedTarget = detectReactMajor(projectRoot);
  // An installed react answers for the major itself; the declared range is never its fallback.
  const target =
    installedTarget ??
    (installedPackageDir("react", projectRoot) ? undefined : declaredReactMajor(projectRoot));
  if (!target) {
    return {
      detected,
      active: false,
      ...(version ? { version } : {}),
      warning: reactCompilerTargetUnknownWarning(projectRoot),
    };
  }
  const runtime = reactCompilerRuntime(target);
  // The probe reads what is installed, so a declared-only target has nothing to probe.
  if (installedTarget && reactCompilerRuntimeDeps(projectRoot, target).length === 0) {
    return {
      detected,
      active: false,
      ...(version ? { version } : {}),
      target,
      skipped: { target, missingModule: runtime.module },
      warning: reactCompilerRuntimeMissingWarning(target, runtime.module, runtime.package),
    };
  }
  return {
    detected,
    active: true,
    pluginPath,
    ...(version ? { version } : {}),
    ...(target ? { target } : {}),
  };
}

// Undeclared, Vite discovers it on first load and full-reloads, destroying the context.
export function reactCompilerRuntimeDeps(
  projectRoot: string,
  target: ReactCompilerTarget = "19",
): string[] {
  const runtime = reactCompilerRuntime(target);
  try {
    createRequire(path.join(projectRoot, "/")).resolve(runtime.module);
    return [runtime.module];
  } catch {
    return [];
  }
}

// The target must be the React the project installs: the compiler emits that runtime import.
export type ReactCompilerTarget = "17" | "18" | "19";

export function detectReactMajor(projectRoot: string): ReactCompilerTarget | undefined {
  const reactDir = installedPackageDir("react", projectRoot);
  if (!reactDir) return undefined;
  return majorOf(readProjectManifest(reactDir)?.version);
}

// With no react installed the declared range is the only evidence of the major there is.
function declaredReactMajor(projectRoot: string): ReactCompilerTarget | undefined {
  const manifest = readProjectManifest(projectRoot) as
    | {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
        peerDependencies?: Record<string, unknown>;
      }
    | undefined;
  return majorOf(
    manifest?.dependencies?.react ??
      manifest?.devDependencies?.react ??
      manifest?.peerDependencies?.react,
  );
}

function majorOf(version: unknown): ReactCompilerTarget | undefined {
  if (typeof version !== "string") return undefined;
  const major = /^\D*(\d+)/.exec(version)?.[1];
  if (major === "17" || major === "18") return major;
  return Number(major) >= 19 ? "19" : undefined;
}

export function reactCompilerRuntime(target: ReactCompilerTarget): {
  module: string;
  package: string;
} {
  return target === "19"
    ? { module: "react/compiler-runtime", package: "react" }
    : { module: "react-compiler-runtime", package: "react-compiler-runtime" };
}

// A defaulted option is one this run cannot disclose, so a known target is always passed.
export function reactCompilerBabelOptions(
  target: ReactCompilerTarget | undefined,
): Record<string, string> {
  return target ? { target } : {};
}

export function reactCompilerRuntimeMissingWarning(
  target: ReactCompilerTarget,
  module: string,
  supplier: string,
): string {
  return (
    `${REACT_COMPILER_PACKAGE} runs at target ${target} here (the React this project installs), ` +
    `whose runtime import "${module}" ` +
    `does not resolve from this project (${supplier} supplies it); skipping the compiler ` +
    "transform and measuring without it."
  );
}

// The generated entry imports the JSX runtime, which a cold optimizer would full-reload for.
export function reactJsxRuntimeDeps(projectRoot: string): string[] {
  const projectRequire = createRequire(path.join(projectRoot, "/"));
  const deps: string[] = [];
  for (const dep of ["react/jsx-runtime", "react/jsx-dev-runtime"]) {
    try {
      projectRequire.resolve(dep);
      deps.push(dep);
    } catch {
      // An unresolvable optimizeDeps include aborts server start.
    }
  }
  return deps;
}

// Imported on demand: a run without the compiler never loads @babel/core.
export async function loadReactCompilerPlugin(
  pluginPath: string,
  target?: ReactCompilerTarget,
): Promise<unknown[]> {
  const mod = await import("@vitejs/plugin-react");
  const factory = (mod as { default?: unknown }).default ?? mod;
  if (typeof factory !== "function") {
    throw new Error("@vitejs/plugin-react has no callable default export");
  }
  const plugin = (factory as (options: unknown) => unknown)({
    babel: { plugins: [[pluginPath, reactCompilerBabelOptions(target)]] },
  });
  return Array.isArray(plugin) ? plugin : [plugin];
}
