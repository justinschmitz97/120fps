import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import ts from "typescript";
import { projectCompilerOptions } from "./prop-gen.js";
import { isVueFile, parseSfcScript, type VueSfcCompiler } from "./vue-sfc.js";
import { detectPnP, findWorkspaceRoot, isPackageAvailable } from "./project-model.js";

// The marker package a server module imports to make the boundary explicit.
// M72: "next/server-only" was never a real module (Next.js re-exports the
// real "server-only" package unchanged); removed as a dead entry.
const SERVER_ONLY_PACKAGES = new Set(["server-only"]);

const NODE_BUILTINS = new Set(builtinModules);

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
  | "yarn-pnp";

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
];

export function recognizeTransform(
  specifier: string,
  containingFile = "",
): TransformRecognizer | undefined {
  return TRANSFORM_RECOGNIZERS.find((entry) => entry.test(specifier, containingFile));
}

export interface PreflightHit {
  kind: PreflightKind;
  // projectRoot-relative posix paths, measured file first.
  chain: string[];
  // The offending module specifier, for import-edge hits.
  specifier?: string;
  // M48: recognizer code and the plugin family that owns the transform.
  transformCode?: string;
  transformOwner?: string;
}

export interface PreflightResult {
  hard: PreflightHit[];
  soft: PreflightHit[];
  // M48: imports the harness cannot compile because it does not load the
  // project's Vite plugins. Reported, never fatal: some of these still build.
  transforms: PreflightHit[];
  // M65: libraries and local modules whose hooks throw outside their provider.
  // Evidence for a render error, never a finding on its own.
  providers: ProviderHit[];
}

// M65. A hook from one of these throws when its provider is missing, which is
// the single most common reason a component that compiles renders nothing.
export const PROVIDER_LIBRARIES: Record<string, string> = {
  "next-intl": "useTranslations",
  "react-i18next": "useTranslation",
  "react-redux": "useSelector",
  "@tanstack/react-query": "useQuery",
  // M72: routing and meta-framework libraries whose hooks throw outside
  // their router/route context, the same failure shape as the four above.
  "react-router": "useNavigate",
  "react-router-dom": "useNavigate",
  "@remix-run/react": "useLoaderData",
  gatsby: "useStaticQuery",
  "@tanstack/react-router": "useRouter",
  "@tanstack/react-start": "useRouter",
};

export interface ProviderHit {
  // Package name, or the projectRoot-relative path of a local module.
  source: string;
  hook?: string;
  local: boolean;
  chain: string[];
}

// `next-intl/client` is still next-intl; `@scope/pkg/sub` is still `@scope/pkg`.
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export function detectProviderImport(
  specifier: string,
): { source: string; hook: string } | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return undefined;
  const pkg = packageOf(specifier);
  const hook = PROVIDER_LIBRARIES[pkg];
  return hook ? { source: pkg, hook } : undefined;
}

// The shape of a context hook that refuses to run outside its provider: a
// context is created here, and something in the file throws. Text only: the
// point is to name a suspect, not to prove it.
export function detectLocalProviderModule(
  sourceText: string,
): { hook?: string } | undefined {
  if (!/createContext\s*[(<]/.test(sourceText)) return undefined;
  if (!/throw\s+new\s+[\w$]*Error\b/.test(sourceText)) return undefined;
  const hook = /\b(?:function|const|let|var)\s+(use[A-Z][\w$]*)/.exec(sourceText)?.[1];
  return hook ? { hook } : {};
}

export function providerCandidateLabels(hits: ProviderHit[]): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const hit of hits) {
    const label = hit.hook ? `${hit.source} (${hit.hook})` : hit.source;
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (fileName.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

// M57: a `.vue` file is not TypeScript. Its `<script setup>` block is, and that
// is where its imports live: without this the walk would stop at the measured
// file and every guarantee below it would silently become a no-op.
function parse(fileName: string, vueCompiler?: VueSfcCompiler): ts.SourceFile | undefined {
  const text = ts.sys.readFile(fileName);
  if (text === undefined) return undefined;
  if (isVueFile(fileName)) {
    if (!vueCompiler) return undefined;
    const script = parseSfcScript(text, fileName, vueCompiler);
    if (!script) return undefined;
    return ts.createSourceFile(
      fileName,
      script.content,
      ts.ScriptTarget.Latest,
      true,
      script.lang === "tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
  }
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
}

// TypeScript cannot resolve a `.vue` specifier, so relative SFC edges are
// resolved by hand. Aliased ones are not: preflight is a best-effort net, and
// an unresolved edge costs coverage, never a false failure.
function resolveVueImport(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return undefined;
  const target = path.normalize(path.resolve(path.dirname(fromFile), specifier));
  if (/[\\/]node_modules[\\/]/.test(target)) return undefined;
  return fs.existsSync(target) ? target : undefined;
}

// A statement whose specifiers are all type-only is erased before it reaches a
// browser, so it can never be the reason a component fails to mount.
function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false; // side-effect import: always runtime
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamedImports(bindings)) {
    if (clause.name) return false;
    return bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly);
  }
  return false;
}

interface ImportEdge {
  specifier: string;
  typeOnly: boolean;
}

function importEdges(sf: ts.SourceFile): ImportEdge[] {
  const edges: ImportEdge[] = [];
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      edges.push({
        specifier: statement.moduleSpecifier.text,
        typeOnly: isTypeOnlyImport(statement),
      });
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      edges.push({ specifier: statement.moduleSpecifier.text, typeOnly: statement.isTypeOnly });
    }
  }
  return edges;
}

// Only a leading directive prologue counts: a `"use server"` string anywhere
// else is just a string.
function hasUseServerDirective(sf: ts.SourceFile): boolean {
  for (const statement of sf.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) {
      return false;
    }
    if (statement.expression.text === "use server") return true;
  }
  return false;
}

function isNodeBuiltin(specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  return NODE_BUILTINS.has(specifier);
}

function isAsync(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Async) !== 0;
}

// An async function component is a React Server Component. It cannot render in
// a browser at all, so this is a property of the source, not of configuration.
export function detectAsyncComponent(filePath: string, componentName: string): boolean {
  const sf = parse(path.resolve(filePath));
  if (!sf) return false;

  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      const isDefault =
        (ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Default) !== 0;
      const named = statement.name?.text === componentName;
      if ((named || isDefault) && isAsync(statement)) return true;
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.name.text !== componentName) continue;
        const init = decl.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && isAsync(init)) {
          return true;
        }
      }
      continue;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expr = statement.expression;
      if (
        (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) &&
        isAsync(expr)
      ) {
        return true;
      }
    }
  }
  return false;
}

function relative(projectRoot: string, file: string): string {
  return path.relative(projectRoot, file).replace(/\\/g, "/");
}

export interface PreflightOptions {
  projectRoot: string;
  // Entry points into the graph: the measured file, and the wrapper when one
  // is active: a server-only import reaches the browser through either.
  entries: string[];
  componentName?: string;
  // M57: the project's own SFC parser. Absent, `.vue` files are unreadable and
  // the walk stops at them, exactly as it did before this milestone.
  vueCompiler?: VueSfcCompiler;
}

export function runPreflight(options: PreflightOptions): PreflightResult {
  const { projectRoot, entries, vueCompiler } = options;
  const compilerOptions = projectCompilerOptions(entries[0]);

  const hard: PreflightHit[] = [];
  const soft: PreflightHit[] = [];
  const transforms: PreflightHit[] = [];
  const providers: ProviderHit[] = [];
  const providerSources = new Set<string>();
  const parents = new Map<string, string>();
  const seen = new Set<string>();
  const queue: string[] = [];
  const entryFiles = new Set<string>();

  for (const entry of entries) {
    const abs = path.resolve(entry);
    entryFiles.add(abs);
    if (seen.has(abs)) continue;
    seen.add(abs);
    queue.push(abs);
  }

  // M72: environment-level rejections, checked once per run and independent
  // of the import graph — a PnP install or a Solid-only project cannot be
  // fixed by walking further, so both fail before that walk starts.
  const entryChain = [relative(projectRoot, path.resolve(entries[0]))];
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  if (detectPnP(workspaceRoot)) {
    hard.push({ kind: "yarn-pnp", chain: entryChain });
  }
  const hasReact =
    isPackageAvailable("react", projectRoot, workspaceRoot) ||
    isPackageAvailable("react-dom", projectRoot, workspaceRoot);
  if (!hasReact && isPackageAvailable("solid-js", projectRoot, workspaceRoot)) {
    hard.push({ kind: "unsupported-framework", chain: entryChain, specifier: "solid-js" });
  }

  const chainTo = (file: string): string[] => {
    const chain: string[] = [];
    let cursor: string | undefined = file;
    while (cursor) {
      chain.unshift(relative(projectRoot, cursor));
      cursor = parents.get(cursor);
    }
    return chain;
  };

  while (queue.length > 0) {
    const file = queue.shift()!;
    const sf = parse(file, vueCompiler);
    if (!sf) continue;

    if (hasUseServerDirective(sf)) {
      hard.push({ kind: "use-server", chain: chainTo(file) });
    }

    // M65: only *imported* modules are provider candidates: a component that
    // creates its own context supplies it too.
    if (!entryFiles.has(file)) {
      const local = detectLocalProviderModule(sf.text);
      const source = relative(projectRoot, file);
      if (local && !providerSources.has(source)) {
        providerSources.add(source);
        providers.push({
          source,
          ...(local.hook ? { hook: local.hook } : {}),
          local: true,
          chain: chainTo(file),
        });
      }
    }

    for (const edge of importEdges(sf)) {
      if (edge.typeOnly) continue;

      const provider = detectProviderImport(edge.specifier);
      if (provider && !providerSources.has(provider.source)) {
        providerSources.add(provider.source);
        providers.push({ ...provider, local: false, chain: chainTo(file) });
      }

      if (SERVER_ONLY_PACKAGES.has(edge.specifier)) {
        hard.push({ kind: "server-only", chain: chainTo(file), specifier: edge.specifier });
        continue;
      }
      if (isNodeBuiltin(edge.specifier)) {
        soft.push({ kind: "node-builtin", chain: chainTo(file), specifier: edge.specifier });
        continue;
      }

      const recognizer = recognizeTransform(edge.specifier, file);
      if (recognizer) {
        transforms.push({
          kind: "project-transform",
          chain: chainTo(file),
          specifier: edge.specifier,
          transformCode: recognizer.code,
          transformOwner: recognizer.owner,
        });
        // A `.vue` edge is a graph edge as well as a transform note: the note
        // must not end the walk, or a server-only import one SFC deep would
        // never be reached.
        if (recognizer.code === "vue" && vueCompiler) {
          const sfc = resolveVueImport(file, edge.specifier);
          if (sfc && !seen.has(sfc)) {
            seen.add(sfc);
            parents.set(sfc, file);
            queue.push(sfc);
          }
        }
        continue;
      }

      const resolved = ts.resolveModuleName(
        edge.specifier,
        file,
        compilerOptions,
        ts.sys,
      ).resolvedModule;
      if (!resolved) continue;

      const target = path.normalize(resolved.resolvedFileName);
      // The graph stops at package boundaries: a dependency's internals are
      // the bundler's problem, and walking them would cost more than the check.
      if (resolved.isExternalLibraryImport || /[\\/]node_modules[\\/]/.test(target)) continue;
      if (target.endsWith(".d.ts")) continue;
      if (seen.has(target)) continue;
      if (!fs.existsSync(target)) continue;

      seen.add(target);
      parents.set(target, file);
      queue.push(target);
    }
  }

  // An async function component is a React Server Component. Vue has no such
  // export shape: an SFC's component is an object, and `async setup()` is a
  // browser-side Suspense concern, not a server boundary.
  if (
    options.componentName &&
    !isVueFile(entries[0]) &&
    detectAsyncComponent(entries[0], options.componentName)
  ) {
    hard.push({ kind: "async-component", chain: [relative(projectRoot, path.resolve(entries[0]))] });
  }

  return { hard, soft, transforms, providers };
}

function chainText(hit: PreflightHit): string {
  return hit.specifier ? [...hit.chain, hit.specifier].join(" → ") : hit.chain.join(" → ");
}

// Only the kinds that can be a hard failure. Node builtins and project
// transforms are reported, never fatal.
type HardKind = Exclude<PreflightKind, "node-builtin" | "project-transform">;

const HARD_CAUSE: Record<HardKind, string> = {
  "server-only": "imports the server-only marker package",
  "use-server": "is a \"use server\" module",
  "async-component": "exports an async function component (a React Server Component)",
  "unsupported-framework": "is measured in a project that declares solid-js; 120fps does not support Solid",
  "yarn-pnp": "is installed via Yarn Plug'n'Play, which 120fps cannot resolve modules through",
};

// M72: the server-boundary remedy ("extract the client part") only makes
// sense for the three original kinds; Solid and PnP need their own next step.
const EXTRACT_REMEDY = [
  "Extract the client part below that boundary, or point 120fps at the client",
  "child component. Pass --no-preflight to attempt the run anyway.",
].join("\n");

const HARD_REMEDY: Record<HardKind, string> = {
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
};

// The first hit is the one to fix: everything below it is unreachable until
// that edge moves.
export function preflightFailureMessage(hits: PreflightHit[]): string {
  const hit = hits[0];
  const where = hit.chain[hit.chain.length - 1];
  const kind = hit.kind as HardKind;
  return [
    `Cannot measure this component in a browser: ${where} ${HARD_CAUSE[kind]}.`,
    "",
    `  ${chainText(hit)}`,
    "",
    HARD_REMEDY[kind],
  ].join("\n");
}

export const NODE_BUILTIN_WARNING = (hit: PreflightHit): string =>
  `${chainText(hit)}: a Node builtin in the component graph. ` +
  "Vite may externalize it; if the run fails to boot, this is the first place to look.";

// Names the transform, not the symptom. Without this the run fails deep inside
// Vite with a message that never mentions the plugin the project relies on.
export const PROJECT_TRANSFORM_WARNING = (hit: PreflightHit): string =>
  `[transform:${hit.transformCode}] ${chainText(hit)}: this project compiles that with ` +
  `${hit.transformOwner}, which 120fps does not load (the harness never reads your vite.config). ` +
  "The import may fail to build, or build unstyled.";

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

export const PREFLIGHT_BYPASSED_WARNING = (hits: PreflightHit[]): string =>
  `--no-preflight bypassed ${hits.length} server-boundary ${hits.length === 1 ? "finding" : "findings"}: ` +
  hits.map(chainText).join("; ");
