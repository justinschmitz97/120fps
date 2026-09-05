import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { transformWithEsbuild } from "vite";
import ts from "typescript";
import {
  detectFramework,
  detectMissingInstall,
  detectPnP,
  findWorkspaceRoot,
  hardRemedyFor,
  isPackageDeclared,
  isVueFile,
  resolveGoverningTsconfig,
} from "../project/index.js";
import { literalPropertyName, stringLiteralValue } from "./vite-config.js";
import { isFile, toPosix } from "../shared/index.js";

// The measured file's extension is stronger evidence than anything in package.json.
export type Renderer = "react" | "vue";

export function rendererFor(filePath: string): Renderer {
  return isVueFile(filePath) ? "vue" : "react";
}

// Not resolveReactDomIdentity (src/analysis/react-profiler.ts): the reverse import is a cycle.
function readReactDomVersion(projectRoot: string): string | undefined {
  try {
    const pkgPath = createRequire(path.join(projectRoot, "/")).resolve("react-dom/package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

export function REACT_DOM_CLIENT_MISSING(projectRoot: string, version: string | undefined): string {
  return (
    `React 18+ required${version ? ` (found react-dom v${version})` : ""}: ` +
    `react-dom/client does not resolve from ${projectRoot}. The harness mounts with createRoot ` +
    "from react-dom/client, which React 16 and 17 do not provide. Upgrade react-dom in the " +
    "project, or measure the component from a project on React 18 or newer."
  );
}

type ReactDomResolutionCause =
  | "pnp"
  | "not-installed"
  | "not-declared"
  | "not-linked"
  | "outdated"
  | "unknown";

function diagnoseReactDomResolutionFailure(
  projectRoot: string,
): { cause: ReactDomResolutionCause; version?: string } {
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  if (detectPnP(workspaceRoot)) return { cause: "pnp" };
  if (detectMissingInstall(projectRoot, workspaceRoot)) return { cause: "not-installed" };
  // Before isPackageDeclared: a resolvable too-old version is a version problem either way.
  const version = readReactDomVersion(projectRoot);
  if (version !== undefined) return { cause: "outdated", version };
  if (isPackageDeclared("react-dom", projectRoot, workspaceRoot)) return { cause: "not-linked" };
  return { cause: "not-declared" };
}

function reactDomNotDeclaredMessage(projectRoot: string, workspaceRoot: string): string {
  if (
    !isPackageDeclared("react", projectRoot, workspaceRoot) &&
    !isPackageDeclared("react-dom", projectRoot, workspaceRoot) &&
    isPackageDeclared("solid-js", projectRoot, workspaceRoot)
  ) {
    return (
      `react-dom/client does not resolve from ${projectRoot}: this project declares solid-js, ` +
      "not react or react-dom.\n\n" +
      hardRemedyFor("unsupported-framework")
    );
  }
  const workspaceClause =
    workspaceRoot !== projectRoot ? ` and workspace root ${workspaceRoot}` : "";
  return (
    `react-dom is not a dependency of this project (checked package.json at ${projectRoot}` +
    `${workspaceClause}); point 120fps at a project that declares it, or install it here.`
  );
}

function reactDomResolutionMessage(
  projectRoot: string,
  diagnosis: { cause: ReactDomResolutionCause; version?: string },
): string {
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  switch (diagnosis.cause) {
    case "pnp":
      return (
        `react-dom/client does not resolve from ${projectRoot}: this workspace installs via ` +
        "Yarn Plug'n'Play, which 120fps cannot resolve modules through.\n\n" +
        hardRemedyFor("yarn-pnp")
      );
    case "not-installed":
      return (
        `react-dom/client does not resolve from ${projectRoot}: this project has no installed ` +
        "dependencies (no node_modules under it or its workspace root).\n\n" +
        hardRemedyFor("not-installed")
      );
    case "not-declared":
      return reactDomNotDeclaredMessage(projectRoot, workspaceRoot);
    case "not-linked":
      return (
        `react-dom is declared in package.json but was not found installed under node_modules ` +
        `from ${projectRoot} up through ${workspaceRoot}; the install may be incomplete, or this ` +
        "workspace member is not linked to it. Reinstall dependencies."
      );
    case "outdated": {
      let message = REACT_DOM_CLIENT_MISSING(projectRoot, diagnosis.version);
      if (isPackageDeclared("preact", projectRoot, workspaceRoot)) {
        message +=
          " This project also declares preact; its preact/compat/client.js already implements " +
          "a createRoot/hydrateRoot shim, but 120fps has no flag to mount through it, so " +
          "upgrading react-dom is still the only supported path.";
      }
      return message;
    }
    case "unknown":
    default:
      return (
        `react-dom/client does not resolve from ${projectRoot}, and 120fps could not determine ` +
        "why: react-dom appears to be installed but its version could not be read."
      );
  }
}

// Checked before boot: an unresolvable optimizeDeps include aborts Vite with a path dump.
export function assertReactDomClient(projectRoot: string): void {
  try {
    createRequire(path.join(projectRoot, "/")).resolve("react-dom/client");
  } catch {
    throw new Error(reactDomResolutionMessage(projectRoot, diagnoseReactDomResolutionFailure(projectRoot)));
  }
}

// No Vue-JSX transform is loaded, so `npm i react-dom` cannot fix a Vue project's `.tsx`.
export function VUE_PROJECT_REACT_FILE_ERROR(relativePath: string): string {
  return (
    `${relativePath} is a ${path.extname(relativePath)} file in a Vue project (this project ` +
    "declares vue and not react-dom). 120fps mounts Vue components from " +
    ".vue single-file components only, so a Vue JSX / render-function file has no mount path " +
    "here; --framework vue cannot change that, because a component always mounts by its file " +
    "extension. Point 120fps at this component's .vue SFC, or measure the file in a project " +
    "that declares react-dom."
  );
}

// Asked before the react-dom question on both paths, so the two agree on the failing question.
export function assertRendererSupported(componentPath: string, projectRoot: string): void {
  if (rendererFor(componentPath) !== "react") return;
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  if (isPackageDeclared("react-dom", projectRoot, workspaceRoot)) return;
  if (detectFramework(projectRoot) !== "vue") return;
  const relative = toPosix(path.relative(projectRoot, path.resolve(componentPath)));
  throw new Error(VUE_PROJECT_REACT_FILE_ERROR(relative === "" ? componentPath : relative));
}

// Two drives have no common ancestor, so the relative result is absolute and carries no "..".
export function isOutsideRoot(
  target: string,
  root: string,
  // An explicit platform makes the drive-letter behavior observable from a test on any host.
  platform: path.PlatformPath = path,
): boolean {
  const relative = platform.relative(root, target);
  return (
    relative === ".." || relative.startsWith(".." + platform.sep) || platform.isAbsolute(relative)
  );
}

// Embedded by the generators after a slash, so an out-of-root component needs /@fs/.
export function componentImportPath(
  componentPath: string,
  projectRoot: string,
  platform: path.PlatformPath = path,
): string {
  if (isOutsideRoot(componentPath, projectRoot, platform)) {
    return "@fs/" + toPosix(componentPath).replace(/^\//, "");
  }
  return toPosix(platform.relative(projectRoot, componentPath));
}

// A disclosure gap only: 120fps applies no next.config/webpack.config alias to its own mount.
const BUNDLER_CONFIG_FILES = [
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
  "next.config.ts",
  "webpack.config.js",
  "webpack.config.mjs",
  "webpack.config.cjs",
  "webpack.config.ts",
];

// Every node is visited: the key appears inside `Object.assign(config.resolve.alias, {...})`.
function findReactDomPreactAlias(source: ts.SourceFile): string | undefined {
  let found: string | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAssignment(node)) {
      const name = literalPropertyName(node);
      if (name === "react-dom") {
        const value = stringLiteralValue(node.initializer);
        if (value && value.includes("preact")) {
          found = value;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function detectBundlerReactDomAlias(
  projectRoot: string,
): { configFile: string; target: string } | undefined {
  for (const name of BUNDLER_CONFIG_FILES) {
    const candidate = path.join(projectRoot, name);
    if (!isFile(candidate)) continue;
    let text: string;
    try {
      text = fs.readFileSync(candidate, "utf-8");
    } catch {
      continue;
    }
    const source = ts.createSourceFile(candidate, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const target = findReactDomPreactAlias(source);
    if (target) return { configFile: candidate, target };
  }
  return undefined;
}

export function BUNDLER_PREACT_ALIAS_WARNING(configFile: string, target: string): string {
  return (
    `${configFile} aliases react-dom to "${target}" for at least one build target 120fps cannot ` +
    "evaluate (the harness never executes your bundler config); if that alias is active in " +
    "production, this measurement runs the real react-dom, not what your app ships."
  );
}

export const DEFAULT_JSX_IMPORT_SOURCE = "react";

// vite:esbuild's default filter excludes plain .js, so a .js with literal JSX never transforms.
export function jsxInJsPlugin(jsxImportSource: string = DEFAULT_JSX_IMPORT_SOURCE): {
  name: string;
  enforce: "pre";
  transform(code: string, id: string): Promise<{ code: string; map: unknown } | null>;
} {
  return {
    name: "120fps-jsx-in-js",
    enforce: "pre",
    async transform(code, id) {
      const file = id.split("?")[0];
      if (!file.endsWith(".js")) return null;
      if (/[\\/]node_modules[\\/]/.test(file)) return null;
      const result = await transformWithEsbuild(code, id, {
        loader: "jsx",
        // Explicit: the "jsx" loader alone leaves esbuild on its classic React.createElement path.
        jsx: "automatic",
        jsxImportSource,
      });
      return { code: result.code, map: result.map };
    },
  };
}

// A preact project's `"jsxImportSource": "preact"` is honoured instead of hard-coding React.
export function resolveJsxImportSource(
  projectRoot: string,
  workspaceRoot: string = findWorkspaceRoot(projectRoot),
  forFile?: string,
): string {
  try {
    // The file, not the root: a directory query matches the first `references` entry instead.
    const declared = resolveGoverningTsconfig(
      forFile ?? projectRoot,
      workspaceRoot,
    ).options.jsxImportSource;
    return declared && declared.length > 0 ? declared : DEFAULT_JSX_IMPORT_SOURCE;
  } catch {
    // A read or parse failure falls back to React rather than failing the run.
    return DEFAULT_JSX_IMPORT_SOURCE;
  }
}
