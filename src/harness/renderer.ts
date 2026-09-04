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

// M57. The measured file's own extension decides how it is mounted: a `.vue`
// SFC cannot be rendered by React and a `.tsx` cannot be rendered by Vue, so
// this is stronger evidence than anything in package.json.
export type Renderer = "react" | "vue";

export function rendererFor(filePath: string): Renderer {
  return isVueFile(filePath) ? "vue" : "react";
}

// M73: the version is read from the project's own react-dom rather than
// resolveReactDomIdentity in src/react-profiler.ts, which imports values from
// this module: the reverse import would close a cycle.
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

// M78: four field-tested repos hit this catch for four different real
// causes, and the old bare catch treated every one of them as "version too
// old" because readReactDomVersion fails the same way for all of them. The
// order matters: a package that genuinely resolves on disk with a real (too
// old) version is a version problem regardless of whether the project's own
// package.json happens to list it, so readReactDomVersion is checked before
// isPackageDeclared, not after.
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

// Checked before the server boots: react-dom/client is forced into
// optimizeDeps.include for every React run, and an unresolvable include aborts
// Vite's optimizer with an esbuild path dump instead of a version diagnosis.
export function assertReactDomClient(projectRoot: string): void {
  try {
    createRequire(path.join(projectRoot, "/")).resolve("react-dom/client");
  } catch {
    throw new Error(reactDomResolutionMessage(projectRoot, diagnoseReactDomResolutionFailure(projectRoot)));
  }
}

// M98 (I2, element-plus-F1). The refusal was right and its reason was wrong: a
// Vue project's render-function `.tsx` was reported as "react-dom is not a
// dependency of this project", which reads as an install problem and invites
// `npm i react-dom` — a remedy that cannot help, since `rendererFor` keys the
// mount on the file extension alone (`harness.ts:36`) and no Vue-JSX transform
// is loaded (`SUPPORTED_TRANSFORM_PLUGINS` carries `@vitejs/plugin-vue`, never
// `@vitejs/plugin-vue-jsx`).
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

// Asked before the react-dom question, on both the dry-run and the real-run
// path, so the two agree on which question the file actually fails. A project
// that declares react-dom is left to `assertReactDomClient` exactly as before:
// this gate only claims the case where no React mount could exist at all.
export function assertRendererSupported(componentPath: string, projectRoot: string): void {
  if (rendererFor(componentPath) !== "react") return;
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  if (isPackageDeclared("react-dom", projectRoot, workspaceRoot)) return;
  if (detectFramework(projectRoot) !== "vue") return;
  const relative = toPosix(path.relative(projectRoot, path.resolve(componentPath)));
  throw new Error(VUE_PROJECT_REACT_FILE_ERROR(relative === "" ? componentPath : relative));
}

// M73: path.win32.relative("C:\\proj", "D:\\x") returns "D:\\x" — two drives
// have no common ancestor to walk up to, so the result is absolute and carries
// no "..". A caller reading only the "../" prefix takes another drive for an
// in-root path. The platform parameter makes the drive-letter behavior
// observable from a test on any host.
export function isOutsideRoot(
  target: string,
  root: string,
  platform: path.PlatformPath = path,
): boolean {
  const relative = platform.relative(root, target);
  return (
    relative === ".." || relative.startsWith(".." + platform.sep) || platform.isAbsolute(relative)
  );
}

// The body of the entry's import specifier: the generators embed it as
// `from "/${componentRelative}"`, so an out-of-root component becomes
// "/@fs/<posix-absolute>", the same escape hatch cssImportSpecifier already
// uses for an out-of-root stylesheet.
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

// M78 (preact-app-F3, the webpack/Next.js shape). A bare-specifier bundler
// alias ("react-dom": "preact/compat") is dropped by readViteConfigData's own
// fs.existsSync requirement above, and no reader exists at all for
// next.config/webpack.config: 120fps applies neither shape to its own mount
// (see the milestone's "Does NOT include"), so this is a disclosure gap, not
// a silent-wrong-analysis risk the way the Vite literal-alias shape is. Same
// invariant as readViteConfigData: text-parsed, never imported, never run.
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

// Walks every node in the file, not just a recognized resolve.alias shape:
// the field-tested pattern is `Object.assign(config.resolve.alias, {...})`
// inside a `webpack:` customizer, so the react-dom key can appear inside a
// plain object literal, a call argument, or an assignment target alike.
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

// M77: Vite's own esbuild transform plugin (`vite:esbuild`) applies ONE
// loader to every file its filter matches; its default filter excludes plain
// `.js`, so a `.js` file with literal JSX (MUI's own authoring convention)
// fails Vite's transform even once the CLI gate accepts it. Widening that
// filter and forcing `loader: "jsx"` was considered and rejected: the loader
// is shared by every matched file, so a widened filter also routes typed
// `.ts`/`.tsx` files through the "jsx" loader, and esbuild's "jsx" loader
// rejects TypeScript-only syntax outright (verified against the installed
// esbuild: `transformSync("interface X{}", { loader: "jsx" })` throws). This
// standalone plugin, run ahead of Vite's own (`enforce: "pre"`), instead
// transforms only `.js` outside `node_modules` with esbuild's "jsx" loader
// directly; by the time Vite's own `vite:esbuild` plugin looks at the file,
// its default filter already excludes `.js`, so nothing there re-transforms
// it. Vendored `.js` under node_modules, and every `.ts`/`.tsx` file, never
// reach this plugin at all.
export const DEFAULT_JSX_IMPORT_SOURCE = "react";

//
// M97 (I1, material-ui-F2): the loader alone is not the whole transform.
// Vite's `transformWithEsbuild` reads the project tsconfig's JSX settings only
// for the "ts"/"tsx" loaders (vite 6.4.2, dep chunk :9086), so `loader: "jsx"`
// left `compilerOptions.jsx` undefined and esbuild fell back to its classic
// `React.createElement` transform. A `.js` authored for the automatic runtime
// (`"jsx": "react-jsx"`, no `React` binding of its own — MUI's
// `internal/svg-icons/*.js`) then threw `React is not defined` the instant the
// module evaluated. The runtime is passed explicitly: automatic, with the
// project's own `jsxImportSource` when its tsconfig sets one. Automatic also
// compiles a file that does import React, so one setting covers both forms.
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
        jsx: "automatic",
        jsxImportSource,
      });
      return { code: result.code, map: result.map };
    },
  };
}

// The runtime package whose `/jsx-runtime` the automatic transform imports.
// Read from the config that governs the project (the same
// `findCompilerConfig` walk alias construction and prop extraction use), so a
// preact project's `"jsxImportSource": "preact"` is honoured instead of
// hard-coding React. Any read/parse failure falls back to React rather than
// failing the run: the previous behaviour compiled these files at all.
export function resolveJsxImportSource(
  projectRoot: string,
  workspaceRoot: string = findWorkspaceRoot(projectRoot),
  forFile?: string,
): string {
  try {
    // M109 (I1): the governing config, so a references-only root reaches the
    // referenced config that declares jsxImportSource. The file decides which
    // referenced config that is: a directory query matches whichever config
    // covers any file under the root, which is the first `references` entry,
    // not the one covering the component being measured.
    const declared = resolveGoverningTsconfig(
      forFile ?? projectRoot,
      workspaceRoot,
    ).options.jsxImportSource;
    return declared && declared.length > 0 ? declared : DEFAULT_JSX_IMPORT_SOURCE;
  } catch {
    return DEFAULT_JSX_IMPORT_SOURCE;
  }
}
