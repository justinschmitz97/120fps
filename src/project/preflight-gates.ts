import fs from "node:fs";
import path from "node:path";
import {
  findWorkspaceRoot,
  installedPackageDir,
  isPackageDeclared,
  workspaceLevels,
} from "./model.js";
import { detectProjectTransforms, SUPPORTED_TRANSFORM_PLUGINS } from "./transforms.js";
import type { PreflightHit } from "./preflight.js";

export type PreflightKind =
  | "server-only"
  | "use-server"
  | "async-component"
  | "node-builtin"
  // M48: an import whose compilation depends on a project Vite plugin the
  // harness deliberately does not load.
  | "project-transform"
  // M72: the project declares solid-js and neither react nor react-dom, so
  // the measured tree cannot be a React tree.
  | "unsupported-framework"
  // M72: the workspace installs via Yarn Plug'n'Play, which node_modules-
  // based resolution (this harness's, and Vite's) cannot read.
  | "yarn-pnp"
  // M78: no level from the member up through the workspace root has ever
  // been installed. Checked after the PnP check (a legitimate PnP project
  // never has node_modules by design) so the two are not confused.
  | "not-installed"
  // M106 A2 (excalidraw-F1): the import graph returns to the measured module.
  // Soft: the cycle is the application's own and usually mounts; it only
  // fails when the entry enters it at a point the application never does.
  | "import-cycle"
  // M110 A5 end-game (directus-NEW1): an import whose file type Vite parses as
  // JavaScript unless a plugin claims it, and that no transform 120fps loads
  // claims. Hard: the dev server answers that request with a 500 and the run
  // dies inside Vite's import analysis, so refusing before the browser starts
  // is the only outcome that names a cause.
  | "unloadable-file-type";

// The harness never loads the project's vite.config (M30): its plugins target
// its own Vite major and its server options are not measurement-safe. That is
// the right architecture and the wrong error experience: a run would otherwise
// fail deep inside Vite without ever naming the transform that was missing.
//
// Each entry carries a stable `code` so dogfooding and issue reports reveal
// which transforms actually block runs, instead of the list being guessed.
export interface TransformRecognizer {
  code: string;
  // `containingFile` is available because some transforms are only visible on
  // disk: vanilla-extract is imported as `./styles.css` while the file is
  // `styles.css.ts`, so the specifier alone cannot identify it.
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
  // M75: Vite core serves `.wasm?init` and `.wasm?url`; the bare specifier is
  // the one that needs a plugin, so only that shape is claimed here.
  {
    code: "wasm",
    test: (s) => /\.wasm$/.test(s),
    owner: "vite-plugin-wasm",
  },
  // M110 (A5, directus): Vite parses an imported file as JavaScript unless a
  // plugin claims it. A YAML, TOML or Markdown import therefore ends the run on
  // a parse error that never names the plugin the project itself declares for
  // that extension.
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
  // M108 A6 (documenso-F1): a Babel macro is compiled away by a plugin before
  // any bundler sees it. Nothing is on disk behind the specifier, so the
  // extension-based recognizers above never match it.
  {
    code: "babel-macro",
    test: (s) => isMacroSpecifier(s),
    owner: "a Babel macro compiler the project configures in its vite.config",
  },
  // M108 A7 (hoppscotch-F2): a virtual namespace is generated at request time
  // by a plugin. Same shape: no file, no extension, no build that produces one.
  {
    code: "virtual-module",
    test: (s, containingFile) => recognizeVirtualNamespace(s, containingFile) !== undefined,
    owner: "a Vite plugin the project configures in its vite.config",
  },
];

// M108 A6/A7. The namespace, and the packages that can own it: a specifier in
// the `unplugin-` namespace names its own producer, and the two other
// namespaces are owned by the plugins seen producing them.
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
  // M108 review: `~icons/` and `virtual:` name nothing that can be on disk, but
  // the bare `unplugin-` prefix also starts ordinary package names
  // (`unplugin-icons/runtime` is a real file inside an installed package). An
  // installed package answers for the specifier, so it is not a virtual module.
  if (entry.prefix === "unplugin-" && containingFile) {
    const pkg = specifier.split("/")[0];
    if (installedPackageDir(pkg, path.dirname(containingFile)) !== undefined) return undefined;
  }
  // `unplugin-icons/types/react` names its producer in the specifier itself.
  const own = entry.prefix === "unplugin-" ? [specifier.split("/")[0]] : [];
  return { namespace: entry.prefix, candidates: [...entry.packages, ...own] };
}

// `styled-components/macro` and `@lingui/react/macro` are the two shapes in the
// corpus; `babel-plugin-macros` itself is imported directly by a few.
export function isMacroSpecifier(specifier: string): boolean {
  // M108 review: a relative `./macro` is a source file of this project, not a
  // macro package. Flagging it prints an untrue transform note and ends the
  // preflight walk at that edge, hiding whatever that file itself imports.
  if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
  return (
    /\/macro$/.test(specifier) ||
    /\.macro$/.test(specifier) ||
    specifier === "babel-plugin-macros"
  );
}

// M110 (A5): the loader packages that claim each extension, most common first.
// The project declaring one of them is the project naming its own plugin
// (directus declares `@rollup/plugin-yaml` and its vite.config loads
// `src/lang/translations/en-US.yaml` with it).
const DATA_LOADER_CANDIDATES: Record<string, string[]> = {
  yaml: ["@rollup/plugin-yaml", "@modyfi/vite-plugin-yaml", "vite-plugin-yaml"],
  toml: ["@rollup/plugin-toml", "vite-plugin-toml"],
  markdown: ["unplugin-vue-markdown", "vite-plugin-md", "vite-plugin-markdown"],
  graphql: ["@rollup/plugin-graphql", "vite-plugin-graphql-loader", "@graphql-tools/vite"],
};

// The recognizer codes whose files Vite hands to its JavaScript parser: an
// import of one of them ends the run with `Failed to parse source for import
// analysis` unless a plugin claims it first. Every entry has a loader table
// above, and none of them is a transform 120fps can load.
export const UNLOADABLE_FILE_TYPE_CODES = new Set(Object.keys(DATA_LOADER_CANDIDATES));

function macroCompilerCandidates(specifier: string): string[] {
  const candidates = ["vite-plugin-babel-macros", "babel-plugin-macros"];
  // A scoped package that ships a macro usually ships the Vite plugin that
  // compiles it beside it (@lingui/react/macro → @lingui/vite-plugin).
  if (specifier.startsWith("@")) candidates.push(`${specifier.split("/")[0]}/vite-plugin`);
  return candidates;
}

// M108 A6/A7 MUST NOT: name only a package this repository declares. With none
// declared the recognizer's own generic wording stands.
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

// M78: directory existence only, mirroring isInstalledAt's own fs.existsSync
// style (project-model.ts) — an empty-but-present node_modules is out of
// scope (no field-test evidence for that shape). The single source of truth
// runPreflight and assertReactDomClient's taxonomy both consult, so a run
// says the same thing whether the rejection lands before the harness builds
// or as buildAndServe's own backstop.
export function detectMissingInstall(memberRoot: string, workspaceRoot: string): boolean {
  return workspaceLevels(memberRoot, workspaceRoot).every(
    (level) => !fs.existsSync(path.join(level, "node_modules")),
  );
}

function chainText(hit: PreflightHit): string {
  return hit.specifier ? [...hit.chain, hit.specifier].join(" → ") : hit.chain.join(" → ");
}

// Only the kinds that can be a hard failure. Node builtins and project
// transforms are reported, never fatal.
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
};

// M72: the server-boundary remedy ("extract the client part") only makes
// sense for the three original kinds; Solid and PnP need their own next step.
const EXTRACT_REMEDY = [
  "Extract the client part below that boundary, or point 120fps at the client",
  "child component. Pass --no-preflight to attempt the run anyway.",
].join("\n");

// M78: exported so assertReactDomClient's own taxonomy (src/harness.ts) can
// reuse the yarn-pnp/not-installed/unsupported-framework remedies verbatim —
// a run says the same thing whether it dies here or as buildAndServe's own
// backstop.
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
  // Unlike every other hard kind, no "--no-preflight" escape hatch: nothing
  // is installed for the harness to boot against, so bypassing this specific
  // check cannot succeed.
  "not-installed":
    "Run your package manager's install (npm install, yarn install, or pnpm install), then " +
    "measure again.",
  // M110 A5 end-game: the run cannot be rescued by installing anything -- the
  // plugin exists and 120fps still will not load it -- so the remedy is to
  // measure a graph that does not reach the import.
  "unloadable-file-type":
    "Measure a component whose graph does not reach that import, or give this one a fixture " +
    "(120fps.fixture.tsx) or a wrapper (--wrap, 120fps.setup.tsx) that supplies the data instead " +
    "of importing the file. Pass --no-preflight to attempt the run anyway.",
};

// M105 (solid-ui-F1): the escape hatch every hard remedy offers is useless
// advice to a run that already took it — the same output prints
// "--no-preflight bypassed 1 ... finding" two lines above. Process-level
// state, set once from the parsed flag, for the same reason
// `setCurrentRunProjectRoot` is: the remedy text is built three call layers
// below the arguments, and one of its call sites is in another module's
// failure path.
let preflightBypassed = false;

export function setPreflightBypassed(bypassed: boolean): void {
  preflightBypassed = bypassed;
}

const BYPASS_ADVICE = /\s*Pass --no-preflight to attempt the run anyway\./g;

export function hardRemedyFor(kind: HardKind): string {
  const remedy = HARD_REMEDY[kind];
  return preflightBypassed ? remedy.replace(BYPASS_ADVICE, "").trim() : remedy;
}

// M78/M79 (excalidraw-F3's compounding note): marks a thrown error as a
// preflight hard-rejection — nothing has been built yet, so the diagnosis is
// already complete. analyze.ts's outer catch checks for this marker and skips
// appending accumulated warnings/transform notes, which would otherwise stack
// an unrelated "needs a CSS preprocessor" note on top of a PnP/Solid/
// not-installed rejection that already names the real, sufficient fix.
export class PreflightHardRejectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightHardRejectionError";
  }
}

// The first hit is the one to fix: everything below it is unreachable until
// that edge moves.
export function preflightFailureMessage(hits: PreflightHit[]): string {
  // M110: the unloadable-file-type promotion appends to `hard` after the walk,
  // and both call sites append composed-child hits after that, so position no
  // longer encodes precedence. Every other refusal names an edge that fails
  // before Vite reaches the data file, so it stays the one reported.
  const hit = hits.find((candidate) => candidate.kind !== "unloadable-file-type") ?? hits[0];
  const where = hit.chain[hit.chain.length - 1];
  const kind = hit.kind as HardKind;
  // M94: a Vite failure is re-presented as a 120fps error naming target,
  // importer and remedy. This one is refused before Vite ever sees the file, so
  // the importer, the import and the plugin the project declares for it are all
  // still in hand.
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

// M106 A2: the remedy is the one shape that reliably re-enters a cycle where
// the application does — a wrapper module that imports the package's own root
// first, which the generated entry emits before the component import.
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

// One formatter for every soft hit, dispatching on the hit's own kind. The
// historical name is kept because it is what both call sites in src/analyze.ts
// import; SOFT_HIT_WARNING is the name to migrate to.
export const SOFT_HIT_WARNING = (hit: PreflightHit): string =>
  hit.kind === "import-cycle" ? IMPORT_CYCLE_WARNING(hit) : NODE_BUILTIN_TEXT(hit);

export const NODE_BUILTIN_WARNING = SOFT_HIT_WARNING;

// M79 (twenty-F3, half 2). The css-preprocessor recognizer above performs no
// availability check by design (recognizeTransform's return shape is
// test-locked, see project-transforms.test.ts:98-99): it fires for every
// .scss/.sass/.less/.styl(us) import whether or not sass/less/stylus is
// actually installed. Vite's own CSS pipeline resolves the preprocessor
// directly — it is never loaded as a Vite plugin object, so it is
// deliberately absent from harness.ts's SUPPORTED_TRANSFORM_PLUGINS — which
// means the downstream consumer (analyze.ts) is the only place that can tell
// "installed" apart from "declared but not installed" apart from "neither".
// Mirrors harness.ts's own private PREPROCESSOR_PACKAGES table (CSS-discovery
// region, owned elsewhere); duplicated here rather than importing across that
// boundary, since it is four stable entries.
export const CSS_PREPROCESSOR_PACKAGES: Record<string, string[]> = {
  ".scss": ["sass", "sass-embedded"],
  ".sass": ["sass", "sass-embedded"],
  ".less": ["less"],
  ".styl": ["stylus"],
  ".stylus": ["stylus"],
};

export type PreprocessorAvailability = "installed" | "declared-not-installed" | "neither";

// undefined for anything that is not a css-preprocessor hit with a known
// extension: those callers keep today's unconditional wording.
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

// M110 (I3): one filter for both modes. The real run and `--explain-props` read
// the same `preflight.transforms` list, and drifting filters were why a dry run
// stayed silent about the 13 preprocessor imports the real run named a minute
// later from the same files on disk.
//
// Dropped here: a transform the run actually applies (the project's plugin is
// installed and loadable), and a preprocessor Vite resolves on its own because
// the project has it installed. Everything else keeps its input order.
export function classifyProjectTransformHits(
  projectRoot: string,
  transforms: PreflightHit[],
  opts: { noTransforms?: boolean; workspaceRoot?: string } = {},
): Array<{ hit: PreflightHit; availability: PreprocessorAvailability | undefined }> {
  if (opts.noTransforms) return [];
  const loadable = new Set(detectProjectTransforms(projectRoot).map((t) => t.code));
  const workspaceRoot = opts.workspaceRoot ?? findWorkspaceRoot(projectRoot);
  return transforms
    .filter((hit) => !hit.transformCode || !loadable.has(hit.transformCode))
    .map((hit) => ({
      hit,
      availability: classifyPreprocessorAvailability(hit, projectRoot, workspaceRoot),
    }))
    .filter(({ availability }) => availability !== "installed");
}

// Names the transform, not the symptom. Without this the run fails deep inside
// Vite with a message that never mentions the plugin the project relies on.
// `availability` is only meaningful for a css-preprocessor hit (see above);
// every other transform kind is unaffected and keeps the original wording.
export const PROJECT_TRANSFORM_WARNING = (
  hit: PreflightHit,
  availability?: PreprocessorAvailability,
): string => {
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

// Appended to whatever error ended the run: a transform the harness cannot
// apply is the first thing to check when a build or readiness failure appears.
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

// M105 (pnp-app-F1): one template used to call every hard kind a
// "server-boundary finding", including the two this file's own HARD_CAUSE
// table describes in completely different terms. Each kind is named as
// itself; the three that really are one boundary keep sharing that name.
const BYPASS_KIND_LABEL: Record<HardKind, string> = {
  "server-only": "server-boundary",
  "use-server": "server-boundary",
  "async-component": "server-boundary",
  "unsupported-framework": "solid",
  "yarn-pnp": "yarn-pnp",
  "not-installed": "not-installed",
  "unloadable-file-type": "unloadable-file-type",
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
