import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import ts from "typescript";
import { projectCompilerOptions } from "./prop-gen.js";
import { isVueFile, parseSfcScript, type VueSfcCompiler } from "./vue-sfc.js";
import {
  detectPnP,
  findWorkspaceRoot,
  installedPackageDir,
  isPackageDeclared,
  workspaceLevels,
} from "./project-model.js";

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
  | "yarn-pnp"
  // M78: no level from the member up through the workspace root has ever
  // been installed. Checked after the PnP check (a legitimate PnP project
  // never has node_modules by design) so the two are not confused.
  | "not-installed"
  // M106 A2 (excalidraw-F1): the import graph returns to the measured module.
  // Soft: the cycle is the application's own and usually mounts; it only
  // fails when the entry enters it at a point the application never does.
  | "import-cycle";

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

// M92 gap 2 (dub tooltip.tsx, verified against real source): headless-UI
// kits ship many separate packages, each with its own `.Provider` component
// rather than one shared hook (`@radix-ui/react-tooltip`,
// `@radix-ui/react-dialog`, ...) -- PROVIDER_LIBRARIES's one-exact-name,
// one-known-hook shape does not fit. Matched by scope prefix instead, with
// no invented hook name (the label is the bare package name, same as any
// PROVIDER_LIBRARIES entry would be without a configured hook). Only the
// one scope actually evidenced in the corpus (dub's own
// `@radix-ui/react-tooltip` import) is listed here -- no other headless kit
// is added without the same kind of evidence.
const PROVIDER_LIBRARY_SCOPES = ["@radix-ui/"];

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
): { source: string; hook?: string } | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return undefined;
  const pkg = packageOf(specifier);
  const hook = PROVIDER_LIBRARIES[pkg];
  if (hook) return { source: pkg, hook };
  if (PROVIDER_LIBRARY_SCOPES.some((scope) => pkg.startsWith(scope))) return { source: pkg };
  return undefined;
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

// M92 gap 2 (dub tooltip.tsx, verified against real source): the extremely
// common "thin wrapper around a headless-kit primitive" shape --
// `export function TooltipProvider({ children }) { return
// <TooltipPrimitive.Provider ...>{children}</TooltipPrimitive.Provider>; }`
// -- has no local createContext and no local throw (dub's real tooltip.tsx:
// `grep -c createContext` and `grep -c "throw new Error"` both 0; Radix's
// own hook throws, not this file's), so detectLocalProviderModule's shape
// never matches it. Every Radix/headless-kit consumer wraps primitives
// exactly this way, so this is handled generically (any package whose
// default export ends in "Provider" JSX, or a `.Provider` member access) --
// not by naming one library. Text only, same convention and same reason as
// detectLocalProviderModule: the point is to name a suspect, not to prove
// it. The exported component's own name (e.g. "TooltipProvider") is
// returned as the hook slot -- not a literal `use*` hook, but the same
// place providerCandidateLabels reads for the parenthetical, and the same
// symbol rankProviderCandidates matches a thrown error's named symbol
// against.
const EXPORTED_PROVIDER_COMPONENT =
  /export\s+(?:default\s+)?(?:async\s+)?function\s+(\w*Provider)\b|export\s+const\s+(\w*Provider)\s*[:=]/;
// A JSX tag name (bare `TooltipProvider` or namespaced `TooltipPrimitive.
// Provider`) whose own final segment ends in "Provider". Captured as a whole
// tag name and checked with `.endsWith()` in JS, not asserted purely in the
// regex: a fixed-length trailing-literal alternation
// (`(?:\.\w*Provider|Provider)\b` appended after a greedy `[\w$]*`) back-
// tracks incorrectly for the namespaced case -- greedy `[\w$]*` already
// consumes the whole bare identifier, leaving nothing left for a second
// "Provider" to match against, and produces a false negative exactly on
// `<TooltipPrimitive.Provider` (dub's own shape).
const JSX_ELEMENT_NAME = /<([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)/g;

function hasJsxProviderElement(sourceText: string): boolean {
  for (const match of sourceText.matchAll(JSX_ELEMENT_NAME)) {
    if (match[1].endsWith("Provider")) return true;
  }
  return false;
}

export function detectWrapperProviderModule(
  sourceText: string,
): { hook?: string } | undefined {
  // A file that creates its own context is detectLocalProviderModule's
  // exclusive territory, throw-gated or not: React's own Context.Provider
  // (`<XxxContext.Provider>`) also ends in "Provider" and would otherwise
  // false-positive here on exactly the shape detectLocalProviderModule
  // deliberately withholds (a context with a benign default that never
  // throws) -- regressing "does not flag a local context module that never
  // throws". This detector is for a file with no local context of its own
  // at all: a re-export/wrapper around another package's already-created
  // Provider.
  if (/createContext\s*[(<]/.test(sourceText)) return undefined;
  const exported = EXPORTED_PROVIDER_COMPONENT.exec(sourceText);
  if (!exported) return undefined;
  if (!hasJsxProviderElement(sourceText)) return undefined;
  const name = exported[1] ?? exported[2];
  return name ? { hook: name } : {};
}

// M92 gap 3 (dub tooltip.tsx -> rich-text-provider.tsx, verified against
// real source): tooltip.tsx:12 imports PROSE_STYLES from ./rich-text-area,
// an unrelated named export -- rich-text-provider.tsx is genuinely
// reachable from the component's own graph, two hops out, so
// providersFromEntry correctly keeps it (it must NOT be filtered away: the
// candidate is real). What is false is calling that reach "component
// imports X" (hints.ts's PROVIDER_HINT_LINE) -- the component imports
// tooltip.tsx, which imports rich-text-provider.tsx; the component itself
// never does. A hit's chain always ends at the file the detector actually
// inspected: for a local hit (detectLocalProviderModule /
// detectWrapperProviderModule) that IS the provider file itself, so
// chain.length - 1 counts the hops from the entry to it. For an external
// package hit (detectProviderImport) the chain ends at the file whose OWN
// import statement named the package -- the package sits one hop beyond
// that file, so the hop count is chain.length, not chain.length - 1.
// "Direct" (the entry's own import statement names it, or is the file
// itself) is exactly one hop either way.
export function isDirectProviderHit(hit: ProviderHit): boolean {
  const hops = hit.local ? hit.chain.length - 1 : hit.chain.length;
  return hops === 1;
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

// M92 (dub button.tsx): runPreflight's entries[] can name more than one seed
// (the measured component plus an auto-detected or explicit --wrap file),
// and its one combined walk does not otherwise distinguish which seed
// discovered which provider hit. hints.ts's PROVIDER_HINT_LINE wording
// ("component imports X") is only true of a hit whose own chain started at
// the component's own entry -- chainTo (this file) always walks a hit's
// chain back to whichever entries[] seed has no parent, so chain[0] is
// exactly that root, with no extra field needed. A hit reached only through
// the wrapper's graph is real evidence, just not evidence about the
// component, so it is excluded here rather than mislabeled.
export function providersFromEntry(hits: ProviderHit[], entryRelative: string): ProviderHit[] {
  return hits.filter((hit) => hit.chain[0] === entryRelative);
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
  const cycleReported = new Set<string>();
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
  } else if (detectMissingInstall(projectRoot, workspaceRoot)) {
    hard.push({ kind: "not-installed", chain: entryChain });
  }
  // M72 (fixed post-review): isPackageAvailable also counts a transitive,
  // hoisted node_modules/<pkg> nobody declared (M68's declared-vs-available
  // split). A hard rejection is consequential enough to key on declaration
  // only (M27's rule) — both to avoid rejecting a Vue/vanilla project over a
  // dependency's own transitive solid-js, and because the failure message
  // below asserts "declares solid-js", which must be literally true. The
  // react-also-declared exception uses the same, symmetric standard: a
  // hoisted-but-undeclared react does not excuse a declared solid-js either.
  const hasReact =
    isPackageDeclared("react", projectRoot, workspaceRoot) ||
    isPackageDeclared("react-dom", projectRoot, workspaceRoot);
  if (!hasReact && isPackageDeclared("solid-js", projectRoot, workspaceRoot)) {
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
    // M92 gap 2: detectLocalProviderModule's own createContext+throw shape
    // tried first; detectWrapperProviderModule (a thin re-export/wrapper
    // around another package's Provider, no local context of its own) is
    // the fallback, not a second independent hit -- one file is one
    // candidate, whichever shape it actually matches.
    if (!entryFiles.has(file)) {
      const local = detectLocalProviderModule(sf.text) ?? detectWrapperProviderModule(sf.text);
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
      // M106 A2: a back-edge to the measured module itself. The generated
      // entry is the graph's only root, so it enters this cycle from the
      // component's own file — backwards, compared with the application,
      // whose own root enters it somewhere else — and a module-scope read of
      // a binding that has not initialized yet throws.
      if (entryFiles.has(target) && target !== file && !cycleReported.has(file)) {
        cycleReported.add(file);
        // No `specifier`: chainText would append the raw import text after the
        // resolved file it already names, printing the same hop twice.
        soft.push({
          kind: "import-cycle",
          chain: [...chainTo(file), relative(projectRoot, target)],
        });
      }
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
  const hit = hits[0];
  const where = hit.chain[hit.chain.length - 1];
  const kind = hit.kind as HardKind;
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
export const IMPORT_CYCLE_WARNING = (hit: PreflightHit): string =>
  `${chainText(hit)}: the import graph returns to the measured module (a cycle). The generated ` +
  "entry is this graph's only root, so it enters the cycle at the component's own file rather " +
  "than where the application enters it; a module-scope read of a binding that has not " +
  "initialized yet then fails with \"Cannot access 'X' before initialization\". If the run does " +
  "not become ready with that error, add a 120fps.setup.tsx (or pass --wrap) that imports this " +
  "package's own root module first.";

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
