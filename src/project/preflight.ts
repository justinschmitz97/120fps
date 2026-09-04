import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import ts from "typescript";
import { projectCompilerOptions } from "../props/index.js";
import { setImportCycleReported } from "../browser/index.js";
import { isVueFile, parseSfcScript, type VueSfcCompiler } from "./vue-sfc.js";
import { detectPnP, findWorkspaceRoot, isPackageDeclared } from "./model.js";
import {
  declaredTransformOwner,
  detectMissingInstall,
  recognizeTransform,
  UNLOADABLE_FILE_TYPE_CODES,
  type PreflightKind,
} from "./preflight-gates.js";

// The marker package a server module imports to make the boundary explicit.
// M72: "next/server-only" was never a real module (Next.js re-exports the
// real "server-only" package unchanged); removed as a dead entry.
const SERVER_ONLY_PACKAGES = new Set(["server-only"]);

const NODE_BUILTINS = new Set(builtinModules);

export interface PreflightHit {
  kind: PreflightKind;
  // projectRoot-relative posix paths, measured file first.
  chain: string[];
  // The offending module specifier, for import-edge hits.
  specifier?: string;
  // M106 A2: every chain that returned to an entry module, first one first.
  cycleChains?: string[][];
  // M48: recognizer code and the plugin family that owns the transform.
  transformCode?: string;
  transformOwner?: string;
  // M110: true when `transformOwner` is a package this project declares, false
  // when it is the recognizer's generic wording. The refusal message may only
  // claim "this project compiles that with X" in the first case.
  transformOwnerDeclared?: boolean;
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

// M116 A1: the same file is walked by the dry run, by every composed child and
// by every component of a sweep, and its parse cannot differ between them while
// it sits unchanged on disk. Keyed by mtime and size, so an edit invalidates the
// entry without a flag; a file with no stat (missing, unreadable) is never
// cached, so a file that appears later is read then. Process-local by design:
// nothing here survives the run (M116 MUST NOT).
const parsedFiles = new Map<string, { signature: string; sourceFile: ts.SourceFile | undefined }>();

function fileSignature(fileName: string): string | undefined {
  try {
    const stat = fs.statSync(fileName);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
}

// M57: a `.vue` file is not TypeScript. Its `<script setup>` block is, and that
// is where its imports live: without this the walk would stop at the measured
// file and every guarantee below it would silently become a no-op.
function parse(fileName: string, vueCompiler?: VueSfcCompiler): ts.SourceFile | undefined {
  // A compiler-less walk reads a `.vue` file as unreadable, so the two answers
  // are different facts about the same file and never share a cache entry.
  const cacheKey = `${vueCompiler ? "sfc" : "ts"} ${path.resolve(fileName)}`;
  const signature = fileSignature(fileName);
  if (signature !== undefined) {
    const cached = parsedFiles.get(cacheKey);
    if (cached && cached.signature === signature) return cached.sourceFile;
  }
  const sourceFile = parseUncached(fileName, vueCompiler);
  if (signature !== undefined) parsedFiles.set(cacheKey, { signature, sourceFile });
  return sourceFile;
}

function parseUncached(fileName: string, vueCompiler?: VueSfcCompiler): ts.SourceFile | undefined {
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
function resolveVueImport(
  fromFile: string,
  specifier: string,
  compilerOptions?: ts.CompilerOptions,
): string | undefined {
  // M110 (A5, directus): an SFC imported through a tsconfig path alias
  // (`@/components/v-menu.vue`) is the same graph edge as a relative one.
  // TypeScript's own resolver does not answer for a `.vue` file, so the alias
  // is substituted here and the result probed on disk, the way the relative
  // form already is. Without it the walk stopped at the first aliased SFC and
  // never reached the `.yaml` import four files deeper.
  const candidates =
    specifier.startsWith(".") || specifier.startsWith("/")
      ? [path.resolve(path.dirname(fromFile), specifier)]
      : aliasCandidates(specifier, compilerOptions);
  for (const candidate of candidates) {
    const target = path.normalize(candidate);
    if (/[\\/]node_modules[\\/]/.test(target)) continue;
    if (fs.existsSync(target)) return target;
  }
  return undefined;
}

// The two `paths` shapes TypeScript itself supports: an exact key, or one `*`.
function aliasCandidates(specifier: string, compilerOptions?: ts.CompilerOptions): string[] {
  const paths = compilerOptions?.paths;
  // Same alias base as src/harness.ts:5804 and src/project-model.ts:326:
  // TypeScript 5 leaves `baseUrl` undefined for a tsconfig that declares only
  // `paths`, and records the declaring config through `pathsBasePath` /
  // `configFilePath` instead.
  const base =
    compilerOptions?.baseUrl ??
    (compilerOptions as { pathsBasePath?: string } | undefined)?.pathsBasePath ??
    (compilerOptions?.configFilePath
      ? path.dirname(compilerOptions.configFilePath as string)
      : undefined);
  if (!paths || !base) return [];
  const candidates: string[] = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    const star = pattern.indexOf("*");
    let rest: string;
    if (star === -1) {
      if (pattern !== specifier) continue;
      rest = "";
    } else {
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
      rest = specifier.slice(prefix.length, specifier.length - suffix.length);
    }
    for (const target of targets) {
      candidates.push(path.resolve(base, target.replace("*", rest)));
    }
  }
  return candidates;
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
  const cycleReported = new Set<string>();
  const cycleChains: string[][] = [];
  setImportCycleReported(false);
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
        // M108 A6/A7: a macro or virtual-namespace hit names the plugin this
        // repository declares for it; the recognizer's generic owner stands
        // when no candidate is declared.
        const declaredOwner = declaredTransformOwner(
          recognizer.code,
          edge.specifier,
          projectRoot,
          workspaceRoot,
        );
        transforms.push({
          kind: "project-transform",
          chain: chainTo(file),
          specifier: edge.specifier,
          transformCode: recognizer.code,
          transformOwner: declaredOwner ?? recognizer.owner,
          ...(declaredOwner ? { transformOwnerDeclared: true } : {}),
        });
        // A `.vue` edge is a graph edge as well as a transform note: the note
        // must not end the walk, or a server-only import one SFC deep would
        // never be reached.
        if (recognizer.code === "vue" && vueCompiler) {
          const sfc = resolveVueImport(file, edge.specifier, compilerOptions);
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
        // Review A3: page-errors claims a cycle for a TDZ page error only
        // when one was really found here.
        setImportCycleReported(true);
        // Review A7: one hit per run. A barrel with several importers of the
        // measured module produced one ~500-character warning each, all
        // describing the same situation; the chains are what differ, so they
        // accumulate into the single hit's own list.
        cycleChains.push([...chainTo(file), relative(projectRoot, target)]);
      }
      if (seen.has(target)) continue;
      if (!fs.existsSync(target)) continue;

      seen.add(target);
      parents.set(target, file);
      queue.push(target);
    }
  }

  // Review A7: one `import-cycle` hit for the run, carrying every chain that
  // returned to an entry. `chain` stays the first one so every existing
  // consumer (chainText, the report) reads the same shape as any other hit.
  if (cycleChains.length > 0) {
    soft.push({ kind: "import-cycle", chain: cycleChains[0], cycleChains });
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

  // M110 A5 end-game (directus-NEW1): last, so every refusal that already
  // existed stays the one the message names. A data-file import is only a
  // refusal when nothing 120fps loads claims that extension; the hit stays in
  // `transforms` as well, so --no-preflight still prints the plugin the
  // project declares for it.
  // UNLOADABLE_FILE_TYPE_CODES holds only codes 120fps cannot load (see its
  // own comment above), so membership alone decides this.
  for (const hit of transforms) {
    if (!hit.transformCode) continue;
    if (!UNLOADABLE_FILE_TYPE_CODES.has(hit.transformCode)) continue;
    hard.push({ ...hit, kind: "unloadable-file-type" });
  }

  return { hard, soft, transforms, providers };
}
