import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findWorkspaceRoot,
  installedPackageDir,
  isPackageDeclared,
  workspaceLevels,
} from "./model.js";
import { packageManagerAddCommand, packageManagerInstallCommand } from "./package-manager.js";
import { detectProjectTransforms, SUPPORTED_TRANSFORM_PLUGINS } from "./transforms.js";
import { toPosix } from "../shared/index.js";
import type { PreflightHit } from "./preflight.js";

export type PreflightKind =
  | "server-only"
  | "use-server"
  | "async-component"
  | "node-builtin"
  // An import needing a project Vite plugin the harness deliberately does not load.
  | "project-transform"
  // The project declares solid-js and no react, so the measured tree cannot be a React tree.
  | "unsupported-framework"
  // Yarn Plug'n'Play, which node_modules-based resolution (this harness's, Vite's) cannot read.
  | "yarn-pnp"
  // No level has node_modules; checked after PnP, which legitimately has none by design.
  | "not-installed"
  // Soft: the application's own cycle usually mounts; only a foreign entry point fails.
  | "import-cycle"
  // Hard: the dev server answers 500 and the run dies inside Vite's import analysis.
  | "unloadable-file-type"
  // Hard: no macro compiler is loadable here, so the macro reaches the browser unexpanded.
  | "unloadable-macro"
  // Hard: only the plugin that owns the namespace can produce the module, and none is loaded.
  | "unloadable-virtual-module"
  // Hard: a Next.js build-time module whose export set no shim can cover.
  | "unshimmable-next-module"
  // Hard: neither the project nor 120fps resolves the CSS preprocessor Vite would need.
  | "unavailable-preprocessor"
  // Hard: the tsconfig every transform reads names a file `nuxi prepare` never wrote.
  | "nuxt-not-prepared";

// The harness never loads the project's vite.config, so a missing transform is named here.
export interface TransformRecognizer {
  code: string;
  // containingFile: vanilla-extract imports ./styles.css while the file is styles.css.ts.
  test: (specifier: string, containingFile: string) => boolean;
  owner: string;
}

const VANILLA_EXTRACT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

export const TRANSFORM_RECOGNIZERS: TransformRecognizer[] = [
  {
    code: "svgr",
    test: (s) => /\.svg\?react$/.test(s),
    owner: "vite-plugin-svgr",
  },
  {
    code: "vanilla-extract",
    test: (s, containingFile) => {
      if (/\.css\.(ts|js|tsx|jsx)$/.test(s)) return true;
      if (!s.endsWith(".css") || !s.startsWith(".")) return false;
      const base = path.resolve(path.dirname(containingFile), s);
      return VANILLA_EXTRACT_EXTENSIONS.some((ext) => fs.existsSync(base + ext));
    },
    owner: "@vanilla-extract/vite-plugin",
  },
  {
    code: "graphql",
    test: (s) => /\.(gql|graphql)$/.test(s),
    owner: "a GraphQL loader plugin (e.g. @rollup/plugin-graphql)",
  },
  {
    code: "mdx",
    test: (s) => /\.mdx$/.test(s),
    owner: "@mdx-js/rollup",
  },
  // Vite core serves .wasm?init and .wasm?url; only the bare specifier needs a plugin.
  {
    code: "wasm",
    test: (s) => /\.wasm$/.test(s),
    owner: "vite-plugin-wasm",
  },
  // Vite parses these as JavaScript, ending the run on a parse error that names no plugin.
  {
    code: "yaml",
    test: (s) => /\.ya?ml$/.test(s),
    owner: "a YAML loader plugin (e.g. @rollup/plugin-yaml)",
  },
  {
    code: "toml",
    test: (s) => /\.toml$/.test(s),
    owner: "a TOML loader plugin (e.g. @rollup/plugin-toml)",
  },
  {
    code: "markdown",
    test: (s) => /\.md$/.test(s),
    owner: "a Markdown loader plugin (e.g. unplugin-vue-markdown)",
  },
  {
    code: "shader",
    test: (s) => /\.(glsl|wgsl|vert|frag|geom|comp)$/.test(s),
    owner: "a shader loader plugin (e.g. vite-plugin-glsl)",
  },
  {
    code: "css-preprocessor",
    test: (s) => /\.(scss|sass|less|styl|stylus)$/.test(s),
    owner: "a CSS preprocessor (Vite needs sass/less/stylus installed in the project)",
  },
  {
    code: "vue",
    test: (s) => /\.vue$/.test(s),
    owner: "@vitejs/plugin-vue",
  },
  {
    code: "svelte",
    test: (s) => /\.svelte$/.test(s),
    owner: "@sveltejs/vite-plugin-svelte",
  },
  // Its exports are one per font family, an unbounded set, so no shim of it can ever be complete.
  {
    code: "unshimmable-next-module",
    test: (s) => UNSHIMMABLE_NEXT_MODULES.has(s),
    owner: "the Next.js compiler, which rewrites these imports while the app builds",
  },
  // Nothing is on disk behind a macro specifier, so the extension recognizers never match.
  {
    code: "babel-macro",
    test: (s) => isMacroSpecifier(s),
    owner: "a Babel macro compiler the project configures in its vite.config",
  },
  // A virtual namespace is generated at request time: no file, no extension.
  {
    code: "virtual-module",
    test: (s, containingFile) => recognizeVirtualNamespace(s, containingFile) !== undefined,
    owner: "a Vite plugin the project configures in its vite.config",
  },
];

// Deliberately never shimmed, so the dry run may decide them: an unshimmed next/* module that
// only lacks a shim today stays a warning.
const UNSHIMMABLE_NEXT_MODULES = new Set(["next/font/google"]);

// The namespace and the packages that can own it; an unplugin- specifier names its producer.
const VIRTUAL_NAMESPACE_PRODUCERS: Array<{ prefix: string; packages: string[] }> = [
  { prefix: "~icons/", packages: ["unplugin-icons"] },
  { prefix: "virtual:uno.css", packages: ["unocss", "@unocss/vite"] },
  { prefix: "virtual:windi", packages: ["vite-plugin-windicss"] },
  { prefix: "virtual:pwa-register", packages: ["vite-plugin-pwa"] },
  { prefix: "virtual:", packages: [] },
  { prefix: "unplugin-", packages: [] },
];

export function recognizeVirtualNamespace(
  specifier: string,
  containingFile = "",
): { namespace: string; candidates: string[] } | undefined {
  const entry = VIRTUAL_NAMESPACE_PRODUCERS.find((e) => specifier.startsWith(e.prefix));
  if (!entry) return undefined;
  // unplugin- also starts real package names; an installed one answers, so it is not virtual.
  if (entry.prefix === "unplugin-" && containingFile) {
    const pkg = specifier.split("/")[0];
    if (installedPackageDir(pkg, path.dirname(containingFile)) !== undefined) return undefined;
  }
  // `unplugin-icons/types/react` names its producer in the specifier itself.
  const own = entry.prefix === "unplugin-" ? [specifier.split("/")[0]] : [];
  return { namespace: entry.prefix, candidates: [...entry.packages, ...own] };
}

// The shapes in the corpus: <pkg>/macro, <pkg>.macro, and a direct babel-plugin-macros import.
export function isMacroSpecifier(specifier: string): boolean {
  // A relative ./macro is this project's own file; flagging it would end the walk at that edge.
  if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
  return (
    /\/macro$/.test(specifier) ||
    /\.macro$/.test(specifier) ||
    specifier === "babel-plugin-macros"
  );
}

// Most common first: a project declaring one of them is naming its own plugin.
const DATA_LOADER_CANDIDATES: Record<string, string[]> = {
  yaml: ["@rollup/plugin-yaml", "@modyfi/vite-plugin-yaml", "vite-plugin-yaml"],
  toml: ["@rollup/plugin-toml", "vite-plugin-toml"],
  markdown: ["unplugin-vue-markdown", "vite-plugin-md", "vite-plugin-markdown"],
  graphql: ["@rollup/plugin-graphql", "vite-plugin-graphql-loader", "@graphql-tools/vite"],
};

// Codes Vite hands to its JavaScript parser, and that 120fps has no transform to load.
export const UNLOADABLE_FILE_TYPE_CODES = new Set(Object.keys(DATA_LOADER_CANDIDATES));

// A transform code no supported plugin can ever claim refuses the run; the rest only warn.
export function hardKindForTransformCode(code: string): PreflightKind | undefined {
  if (UNLOADABLE_FILE_TYPE_CODES.has(code)) return "unloadable-file-type";
  if (code === "virtual-module") return "unloadable-virtual-module";
  if (code === "unshimmable-next-module") return "unshimmable-next-module";
  return code === "babel-macro" ? "unloadable-macro" : undefined;
}

function macroCompilerCandidates(specifier: string): string[] {
  const candidates = ["vite-plugin-babel-macros", "babel-plugin-macros"];
  // A scoped macro package usually ships its compiler beside it (@lingui/vite-plugin).
  if (specifier.startsWith("@")) candidates.push(`${specifier.split("/")[0]}/vite-plugin`);
  return candidates;
}

// Only a declared package; with none the recognizer's generic wording stands.
export function declaredTransformOwner(
  code: string,
  specifier: string,
  memberRoot: string,
  workspaceRoot: string = findWorkspaceRoot(memberRoot),
): string | undefined {
  const candidates =
    code === "babel-macro"
      ? macroCompilerCandidates(specifier)
      : code === "virtual-module"
        ? (recognizeVirtualNamespace(specifier)?.candidates ?? [])
        : (DATA_LOADER_CANDIDATES[code] ?? []);
  return candidates.find((pkg) => isPackageDeclared(pkg, memberRoot, workspaceRoot));
}

export function recognizeTransform(
  specifier: string,
  containingFile = "",
): TransformRecognizer | undefined {
  return TRANSFORM_RECOGNIZERS.find((entry) => entry.test(specifier, containingFile));
}

// Shared by runPreflight and assertReactDomClient, so both name the same cause.
export function detectMissingInstall(memberRoot: string, workspaceRoot: string): boolean {
  // Existence only: an empty-but-present node_modules is out of scope.
  return workspaceLevels(memberRoot, workspaceRoot).every(
    (level) => !fs.existsSync(path.join(level, "node_modules")),
  );
}

function chainText(hit: PreflightHit): string {
  return hit.specifier ? [...hit.chain, hit.specifier].join(" → ") : hit.chain.join(" → ");
}

// Node builtins, project transforms and cycles are reported, never fatal.
type HardKind = Exclude<PreflightKind, "node-builtin" | "project-transform" | "import-cycle">;

const HARD_CAUSE: Record<HardKind, string> = {
  "server-only": "imports the server-only marker package",
  "use-server": "is a \"use server\" module",
  "async-component": "exports an async function component (a React Server Component)",
  "unsupported-framework": "is measured in a project that declares solid-js; 120fps does not support Solid",
  "yarn-pnp": "is installed via Yarn Plug'n'Play, which 120fps cannot resolve modules through",
  "not-installed":
    "is measured in a project with no installed dependencies (no node_modules under it or its " +
    "workspace root)",
  "unloadable-file-type": "imports a file type Vite parses as JavaScript unless a plugin claims it",
  "unloadable-macro": "imports a Babel macro that no compiler here expands",
  "unloadable-virtual-module":
    "imports a module from a virtual namespace only a Vite plugin generates",
  "unshimmable-next-module":
    "imports a Next.js build-time module that no shim here can stand in for",
  "unavailable-preprocessor": "imports a stylesheet whose CSS preprocessor nothing here resolves",
  "nuxt-not-prepared": "is measured in a Nuxt project that `nuxi prepare` has not finished",
};

// Only the three server-boundary kinds; Solid and PnP need their own next step.
const EXTRACT_REMEDY = [
  "Extract the client part below that boundary, or point 120fps at the client",
  "child component. Pass --no-preflight to attempt the run anyway.",
].join("\n");

// Exported so assertReactDomClient (harness/renderer.ts) reuses these remedies verbatim.
export const HARD_REMEDY: Record<HardKind, string> = {
  "server-only": EXTRACT_REMEDY,
  "use-server": EXTRACT_REMEDY,
  "async-component": EXTRACT_REMEDY,
  "unsupported-framework":
    "120fps measures React and Vue components; Solid is not supported. Point it at a React or " +
    "Vue component, or remove solid-js if this project no longer uses it. Pass --no-preflight " +
    "to attempt the run anyway.",
  "yarn-pnp":
    "Set nodeLinker: node-modules in .yarnrc.yml and reinstall, or use npm/pnpm instead. Pass " +
    "--no-preflight to attempt the run anyway.",
  // No --no-preflight escape hatch: with nothing installed the harness cannot boot at all.
  "not-installed":
    "Run your package manager's install (npm install, yarn install, or pnpm install), then " +
    "measure again.",
  // No install helps: 120fps will not load the plugin even when the project has it.
  "unloadable-file-type":
    "Measure a component whose graph does not reach that import, or give this one a fixture " +
    "(120fps.fixture.tsx) or a wrapper (--wrap, 120fps.setup.tsx) that supplies the data instead " +
    "of importing the file. Pass --no-preflight to attempt the run anyway.",
  // Expanding the macro by hand is the only edit that keeps the measured tree the same shape.
  "unloadable-macro":
    "In a copy of this component, write the macro call out by hand as the code the compiler " +
    "would have generated, or measure a component below this one whose graph does not reach the " +
    "macro. Pass --no-preflight to attempt the run anyway.",
  // The font import is what has to move; nothing installable makes the module loadable here.
  "unshimmable-next-module":
    "Measure a component whose graph does not reach that import, or move the font import to a " +
    "parent this component does not render. Pass --no-preflight to attempt the run anyway.",
  // Nothing on disk produces it, so only a graph that avoids the namespace can be measured.
  "unloadable-virtual-module":
    "Measure a component whose graph does not reach that import, or give this one a fixture " +
    "(120fps.fixture.tsx) or a wrapper (--wrap, 120fps.setup.tsx) that stubs it. Pass " +
    "--no-preflight to attempt the run anyway.",
  // The command itself is per-project, so the hit carries it and the message prints it above this.
  "unavailable-preprocessor":
    "Install it where the measured package resolves it, then measure again. Pass --no-preflight " +
    "to attempt the run anyway.",
  "nuxt-not-prepared":
    "Run `nuxi prepare` in this project, then measure again. Pass --no-preflight to attempt the " +
    "run anyway.",
};

// Process state like setCurrentRunProjectRoot: the remedy is built three layers below argv.
let preflightBypassed = false;

export function setPreflightBypassed(bypassed: boolean): void {
  preflightBypassed = bypassed;
}

// A run that already passed --no-preflight does not need the flag advised to it.
const BYPASS_ADVICE = /\s*Pass --no-preflight to attempt the run anyway\./g;

export function hardRemedyFor(kind: HardKind): string {
  const remedy = HARD_REMEDY[kind];
  return preflightBypassed ? remedy.replace(BYPASS_ADVICE, "").trim() : remedy;
}

// pipeline/analyze.ts skips appending warnings for this: the diagnosis is already complete.
export class PreflightHardRejectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightHardRejectionError";
  }
}

// Every transform refusal names an import edge; the others fail before Vite gets there.
const TRANSFORM_REFUSAL_KINDS = new Set<PreflightKind>([
  "unloadable-file-type",
  "unloadable-macro",
  "unloadable-virtual-module",
  "unshimmable-next-module",
  "unavailable-preprocessor",
]);

// The first hit is the one to fix: everything below it is unreachable until that edge moves.
export function preflightFailureMessage(hits: PreflightHit[]): string {
  // Position does not encode precedence, so the kind decides which hit the message reports.
  const hit = hits.find((candidate) => !TRANSFORM_REFUSAL_KINDS.has(candidate.kind)) ?? hits[0];
  const where = hit.chain[hit.chain.length - 1];
  const kind = hit.kind as HardKind;
  // esbuild reads that config for every file it transforms, so no component escapes it.
  if (kind === "nuxt-not-prepared" && hit.nuxt) {
    return [
      `Cannot measure this component in a browser: ${where} ${HARD_CAUSE[kind]}: ` +
        `${hit.nuxt.config} names ${hit.nuxt.missing}, which is not on disk.`,
      "",
      `  ${chainText(hit)}`,
      "",
      "Vite's esbuild reads that config for every file it transforms, so the dev server would " +
        "answer 500 on the harness entry before this component is measured.",
      hardRemedyFor(kind),
    ].join("\n");
  }
  // The hit carries the search, because only the walk that produced it knew the two roots.
  if (kind === "unavailable-preprocessor" && hit.preprocessor) {
    const { packages, searched, installCommand, declared } = hit.preprocessor;
    return [
      `Cannot measure this component in a browser: ${where} imports ${hit.specifier}, and the ` +
        `CSS preprocessor Vite compiles it with (${packages.join(" or ")}) resolves nowhere the ` +
        "dev server would look.",
      "",
      `  ${chainText(hit)}`,
      "",
      (declared
        ? "This project declares it, so its node_modules is out of date. "
        : "This project declares it nowhere, and 120fps ships no copy of it. ") +
        `Looked in ${searched.join(", ")} and in 120fps's own installed copy.`,
      "",
      `  ${installCommand}`,
      "",
      hardRemedyFor(kind),
    ].join("\n");
  }
  // Nothing on disk changes this: no macro compiler is among the transforms 120fps loads.
  if (kind === "unloadable-macro") {
    const supported = SUPPORTED_TRANSFORM_PLUGINS.map((plugin) => plugin.code).join(", ");
    return [
      `Cannot measure this component in a browser: ${where} imports ${hit.specifier}, a Babel ` +
        "macro, which a compiler is meant to rewrite away while the project builds.",
      "",
      `  ${chainText(hit)}`,
      "",
      (hit.transformOwnerDeclared
        ? `This project compiles that with ${hit.transformOwner}.`
        : "Nothing in this project declares a macro compiler for it.") +
        ` 120fps loads only its supported transforms (${supported}) and never reads your ` +
        "vite.config, so nothing here expands it: the macro's own module would reach the browser " +
        "instead of the code it would have generated.",
      hardRemedyFor(kind),
    ].join("\n");
  }
  // Nothing the harness can load answers it, and nothing on disk changes that.
  if (kind === "unshimmable-next-module") {
    return [
      `Cannot measure this component in a browser: ${where} imports ${hit.specifier}, a Next.js ` +
        "build-time module that 120fps does not shim and has decided never to shim: its exports " +
        "are one per font family, an unbounded set no shim can cover.",
      "",
      `  ${chainText(hit)}`,
      "",
      "Next's own compiler rewrites that import while the app builds. 120fps never runs that " +
        "compiler, so the harness page would load the real module and the import would fail with " +
        '"does not provide an export named \'default\'".',
      hardRemedyFor(kind),
    ].join("\n");
  }
  // No file behind it, so no build produces one: only the plugin that owns the namespace can.
  if (kind === "unloadable-virtual-module") {
    const supported = SUPPORTED_TRANSFORM_PLUGINS.map((plugin) => plugin.code).join(", ");
    const namespace = recognizeVirtualNamespace(hit.specifier ?? "")?.namespace ?? hit.specifier;
    return [
      `Cannot measure this component in a browser: ${where} imports ${hit.specifier}, a module in ` +
        `the \`${namespace}\` virtual namespace that a Vite plugin generates at request time.`,
      "",
      `  ${chainText(hit)}`,
      "",
      (hit.transformOwnerDeclared
        ? `This project declares ${hit.transformOwner}, the plugin that owns that namespace.`
        : "Nothing in this project declares a plugin that owns that namespace.") +
        ` 120fps loads only its supported transforms (${supported}) and never reads your ` +
        "vite.config, so nothing here answers for that import: the dev server would answer it " +
        "with a 500 and the page would never evaluate.",
      hardRemedyFor(kind),
    ].join("\n");
  }
  // Refused before Vite sees the file, so importer, import and declared plugin are in hand.
  if (kind === "unloadable-file-type") {
    const supported = SUPPORTED_TRANSFORM_PLUGINS.map((plugin) => plugin.code).join(", ");
    return [
      `Cannot measure this component in a browser: ${where} imports ${hit.specifier}, a file ` +
        "type Vite parses as JavaScript unless a plugin claims it.",
      "",
      `  ${chainText(hit)}`,
      "",
      (hit.transformOwnerDeclared
        ? `This project compiles that with ${hit.transformOwner}.`
        : `Nothing in this project declares ${hit.transformOwner}, which Vite needs to load it.`) +
        ` 120fps loads only its supported transforms (${supported}) and never reads your ` +
        "vite.config, so nothing here can load that import: the dev server would answer it " +
        "with a 500 and the run would end inside Vite's import analysis.",
      hardRemedyFor(kind),
    ].join("\n");
  }
  return [
    `Cannot measure this component in a browser: ${where} ${HARD_CAUSE[kind]}.`,
    "",
    `  ${chainText(hit)}`,
    "",
    hardRemedyFor(kind),
  ].join("\n");
}

// A wrapper importing the package root first is the shape that re-enters where the app does.
export const IMPORT_CYCLE_WARNING = (hit: PreflightHit): string => {
  const chains = hit.cycleChains ?? [hit.chain];
  const listed = chains.map((chain) => chain.join(" → ")).join("; ");
  return (
    `${listed}: the import graph returns to the measured module (a cycle). The generated entry is ` +
    "a root of this graph, so it enters the cycle at the component's own file rather than where " +
    "the application enters it; a module-scope read of a binding that has not initialized yet then " +
    "fails with \"Cannot access 'X' before initialization\". If the run does not become ready with " +
    "that error, add a 120fps.setup.tsx (or pass --wrap) that imports this package's own root " +
    "module first."
  );
};

const NODE_BUILTIN_TEXT = (hit: PreflightHit): string =>
  `${chainText(hit)}: a Node builtin in the component graph. ` +
  "Vite may externalize it; if the run fails to boot, this is the first place to look.";

// One formatter for every soft hit, dispatching on the hit's own kind.
export const SOFT_HIT_WARNING = (hit: PreflightHit): string =>
  hit.kind === "import-cycle" ? IMPORT_CYCLE_WARNING(hit) : NODE_BUILTIN_TEXT(hit);

// The name both call sites, pipeline/phases.ts and pipeline/explain-props.ts, import.
export const NODE_BUILTIN_WARNING = SOFT_HIT_WARNING;

// Mirrors harness/stylesheets.ts's private PREPROCESSOR_PACKAGES, duplicated rather than shared.
export const CSS_PREPROCESSOR_PACKAGES: Record<string, string[]> = {
  ".scss": ["sass", "sass-embedded"],
  ".sass": ["sass", "sass-embedded"],
  ".less": ["less"],
  ".styl": ["stylus"],
  ".stylus": ["stylus"],
};

// 120fps declares sass so Vite's second search base answers for a project that has none.
const BUNDLED_PREPROCESSOR_PACKAGES = ["sass"];

// Vite's own fallback base is its install directory, so the probe starts where Vite's does.
function bundledSearchBases(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const viteDir = installedPackageDir("vite", here);
  if (!viteDir) return [here];
  try {
    // Vite reads import.meta.url, which node resolves through the symlink a store install uses.
    return [here, fs.realpathSync(viteDir)];
  } catch {
    return [here, viteDir];
  }
}

const bundledVersions = new Map<string, string | undefined>();

function bundledVersion(pkg: string): string | undefined {
  if (bundledVersions.has(pkg)) return bundledVersions.get(pkg);
  let version: string | undefined;
  for (const base of bundledSearchBases()) {
    const dir = installedPackageDir(pkg, base);
    if (!dir) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
      if (typeof manifest.version === "string") {
        version = manifest.version;
        break;
      }
    } catch {
      // An unreadable manifest is the same as no copy: the refusal path stays truthful.
    }
  }
  bundledVersions.set(pkg, version);
  return version;
}

// The implementation this run would fall through to for that extension, when there is one.
export function bundledPreprocessor(
  extension: string,
): { package: string; version: string } | undefined {
  const packages = CSS_PREPROCESSOR_PACKAGES[extension.toLowerCase()];
  if (!packages) return undefined;
  for (const pkg of packages) {
    if (!BUNDLED_PREPROCESSOR_PACKAGES.includes(pkg)) continue;
    const version = bundledVersion(pkg);
    if (version) return { package: pkg, version };
  }
  return undefined;
}

export type PreprocessorAvailability = "installed" | "declared-not-installed" | "neither";

// What the run will do about the hit: the project's own copy, 120fps's, or refuse.
export type PreprocessorDisposition = PreprocessorAvailability | "bundled";

// undefined for anything but a css-preprocessor hit: those callers keep unconditional wording.
export function classifyPreprocessorAvailability(
  hit: PreflightHit,
  memberRoot: string,
  workspaceRoot: string,
): PreprocessorAvailability | undefined {
  if (hit.transformCode !== "css-preprocessor" || !hit.specifier) return undefined;
  const packages = CSS_PREPROCESSOR_PACKAGES[path.extname(hit.specifier).toLowerCase()];
  if (!packages) return undefined;
  if (packages.some((pkg) => installedPackageDir(pkg, memberRoot) !== undefined)) return "installed";
  if (packages.some((pkg) => isPackageDeclared(pkg, memberRoot, workspaceRoot))) {
    return "declared-not-installed";
  }
  return "neither";
}

// One filter for the real run and --explain-props; drifting filters would disagree on disk.
export function classifyProjectTransformHits(
  projectRoot: string,
  transforms: PreflightHit[],
  opts: { noTransforms?: boolean; workspaceRoot?: string } = {},
): Array<{ hit: PreflightHit; availability: PreprocessorDisposition | undefined }> {
  if (opts.noTransforms) return [];
  const loadable = new Set(detectProjectTransforms(projectRoot).map((t) => t.code));
  const workspaceRoot = opts.workspaceRoot ?? findWorkspaceRoot(projectRoot);
  let disclosedBundled = false;
  return transforms
    .filter((hit) => !hit.transformCode || !loadable.has(hit.transformCode))
    .map((hit) => ({
      hit,
      availability: dispositionFor(hit, projectRoot, workspaceRoot),
    }))
    // A preprocessor is never in loadable: Vite resolves it itself, so availability decides here.
    .filter(({ availability }) => availability !== "installed")
    // One disclosure per run: every .scss edge in the graph compiles with the same copy.
    .filter(({ availability }) => {
      if (availability !== "bundled") return true;
      if (disclosedBundled) return false;
      disclosedBundled = true;
      return true;
    });
}

// The project's own answer first; the bundled copy only decides what happens without one.
function dispositionFor(
  hit: PreflightHit,
  memberRoot: string,
  workspaceRoot: string,
): PreprocessorDisposition | undefined {
  const availability = classifyPreprocessorAvailability(hit, memberRoot, workspaceRoot);
  if (availability === undefined || availability === "installed") return availability;
  return bundledPreprocessor(path.extname(hit.specifier ?? "")) ? "bundled" : availability;
}

// What the refusal has to print, gathered where both roots are still in hand.
export interface PreprocessorSearch {
  packages: string[];
  searched: string[];
  installCommand: string;
  declared: boolean;
}

// Defined only for a hit nothing resolves: an available or bundled preprocessor is no refusal.
export function preprocessorSearchFor(
  hit: PreflightHit,
  memberRoot: string,
  workspaceRoot: string,
): PreprocessorSearch | undefined {
  const disposition = dispositionFor(hit, memberRoot, workspaceRoot);
  if (disposition !== "neither" && disposition !== "declared-not-installed") return undefined;
  const packages = CSS_PREPROCESSOR_PACKAGES[path.extname(hit.specifier ?? "").toLowerCase()] ?? [];
  const searched = workspaceLevels(memberRoot, workspaceRoot).map((level) => {
    const relative = toPosix(path.relative(workspaceRoot, level));
    return relative === "" ? "node_modules" : `${relative}/node_modules`;
  });
  const declared = disposition === "declared-not-installed";
  return {
    packages,
    searched,
    declared,
    installCommand: declared
      ? packageManagerInstallCommand(memberRoot, process.cwd())
      : packageManagerAddCommand(memberRoot, packages[0], process.cwd()),
  };
}

// Names the transform, not the symptom Vite reports without the plugin the project relies on.
export const PROJECT_TRANSFORM_WARNING = (
  hit: PreflightHit,
  availability?: PreprocessorDisposition,
): string => {
  // Tense-neutral on purpose: the dry run predicts the same sentence the real run prints.
  if (hit.transformCode === "css-preprocessor" && availability === "bundled") {
    const extension = path.extname(hit.specifier ?? "").toLowerCase();
    const packages = CSS_PREPROCESSOR_PACKAGES[extension] ?? [];
    const bundled = bundledPreprocessor(extension);
    return (
      `[transform:${hit.transformCode}] ${chainText(hit)}: no ${packages.join(" or ")} resolves ` +
      "from the measured package or its workspace root, so Vite falls through to the copy 120fps " +
      `ships (${bundled?.package} ${bundled?.version}) and this stylesheet compiles with that ` +
      `version rather than one this project pins. Add ${packages[0]} to the measured package to ` +
      "compile with the project's own."
    );
  }
  if (hit.transformCode === "css-preprocessor" && availability === "declared-not-installed") {
    return (
      `[transform:${hit.transformCode}] ${chainText(hit)}: the CSS preprocessor it needs is ` +
      "declared in package.json but not installed; run your package manager's install."
    );
  }
  return (
    `[transform:${hit.transformCode}] ${chainText(hit)}: this project compiles that with ` +
    `${hit.transformOwner}, which 120fps does not load (the harness never reads your vite.config). ` +
    "The import may fail to build, or build unstyled."
  );
};

// Appended to whatever error ended the run: an unapplied transform is the first suspect.
export const transformFailureNote = (hits: PreflightHit[]): string =>
  [
    "",
    "",
    "The measured graph imports files this harness cannot compile:",
    ...hits.map(
      (hit) => `  [transform:${hit.transformCode}] ${chainText(hit)} (needs ${hit.transformOwner})`,
    ),
    "The harness deliberately does not load your vite.config, so those plugins are absent.",
  ].join("\n");

// Each kind is named as itself; only the three real boundary kinds share one label.
const BYPASS_KIND_LABEL: Record<HardKind, string> = {
  "server-only": "server-boundary",
  "use-server": "server-boundary",
  "async-component": "server-boundary",
  "unsupported-framework": "solid",
  "yarn-pnp": "yarn-pnp",
  "not-installed": "not-installed",
  "unloadable-file-type": "unloadable-file-type",
  "unloadable-macro": "babel-macro",
  "unloadable-virtual-module": "virtual-module",
  "unshimmable-next-module": "unshimmable-next-module",
  "unavailable-preprocessor": "css-preprocessor",
  "nuxt-not-prepared": "nuxt-not-prepared",
};

export const PREFLIGHT_BYPASSED_WARNING = (hits: PreflightHit[]): string => {
  const counts = new Map<string, number>();
  for (const hit of hits) {
    const label = BYPASS_KIND_LABEL[hit.kind as HardKind] ?? "preflight";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const noun = hits.length === 1 ? "finding" : "findings";
  const head =
    counts.size === 1
      ? `${hits.length} ${[...counts.keys()][0]} ${noun}`
      : `${hits.length} ${noun} (${[...counts.entries()].map(([label, n]) => `${n} ${label}`).join(", ")})`;
  return `--no-preflight bypassed ${head}: ${hits.map(chainText).join("; ")}`;
};
