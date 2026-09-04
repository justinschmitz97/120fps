import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { installedPackageDir, isPackageDeclared, readProjectManifest } from "./model.js";

export const REACT_COMPILER_PACKAGE = "babel-plugin-react-compiler";

export const REACT_COMPILER_DISABLED_WARNING =
  "React Compiler is installed but disabled for this run; rerender costs will be higher than production.";

// M108 review: the plugin defaults its target to React 19 when none is passed,
// so an undetectable React major would compile against a runtime the project
// may not have, undisclosed. An undisclosable target keeps the compiler off.
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

// Package presence is the whole signal: next.config.* can be TypeScript and can
// compute its own config, which is a large evaluation surface for one boolean.
// Declared, never merely resolvable: the compiler rewrites the code that gets
// measured, so a hoisted transitive copy must not switch it on (M27 H14). The
// workspace root counts as a declaration; a hoisted install does not.
export function detectReactCompiler(projectRoot: string): boolean {
  return isPackageDeclared(REACT_COMPILER_PACKAGE, projectRoot);
}

// Walking up from the resolved entry reaches the package's own manifest in any
// layout; the package.json subpath does not, because an exports map may hide it.
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
  // M108 A3/A4: the React major the transform compiles for, and why it did not
  // run when the runtime that major needs is absent.
  target?: ReactCompilerTarget;
  skipped?: { target: string; missingModule: string };
}

// At most one warning per state, so the disabled note and the resolution note
// can never both reach the report.
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
  // A react that IS installed answers for the major by itself: an unreadable or
  // pre-17 install is an unknown target, never the declared range's answer.
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
  // The runtime probe reads what is installed, so it only speaks when react
  // itself is installed; a declared-only target has nothing to probe.
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

// Compiled output imports react/compiler-runtime. @vitejs/plugin-react only
// pre-bundles that module when it recognises the babel plugin by its bare name,
// and K2 requires the project-resolved absolute path, so the import has to be
// declared here: otherwise Vite discovers it on the first page load and forces
// a full reload that destroys the execution context mid-measurement. React 18
// projects have no such module; there the entry is skipped.
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

// M108 A3 (primer-react-F1): the compiler emits the runtime import its target
// names, so the target has to be the React the project installs. React 19
// ships the runtime inside react itself; 17 and 18 take it from the separate
// react-compiler-runtime package the project installs beside them.
export type ReactCompilerTarget = "17" | "18" | "19";

export function detectReactMajor(projectRoot: string): ReactCompilerTarget | undefined {
  const reactDir = installedPackageDir("react", projectRoot);
  if (!reactDir) return undefined;
  return majorOf(readProjectManifest(reactDir)?.version);
}

// With no react installed the declared range is the only evidence of the major
// there is. An install that reads always wins over it.
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

// M92: an option the plugin defaults for us is an option this run cannot
// disclose, so the target is always passed explicitly once it is known.
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

// Vite transforms the generated .tsx entry with the automatic JSX runtime, so
// the page imports react/jsx-dev-runtime even though nothing declares it. Left
// undeclared, Vite discovers it on the first page load of a project whose
// optimizer cache is cold, pre-bundles it, and full-reloads: destroying the
// execution context mid-measurement. Resolved from the project: React 16 has no
// automatic runtime, and an unresolvable include aborts server start.
export function reactJsxRuntimeDeps(projectRoot: string): string[] {
  const projectRequire = createRequire(path.join(projectRoot, "/"));
  const deps: string[] = [];
  for (const dep of ["react/jsx-runtime", "react/jsx-dev-runtime"]) {
    try {
      projectRequire.resolve(dep);
      deps.push(dep);
    } catch {
      // Not available in this React version.
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
