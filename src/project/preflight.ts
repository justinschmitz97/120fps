import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import ts from "typescript";
import { projectCompilerOptions } from "./compiler-options.js";
import { pathKey, setImportCycleReported, toPosix } from "../shared/index.js";
import { isVueFile, parseSfcScript, type VueSfcCompiler } from "./vue-sfc.js";
import { detectPnP, findWorkspaceRoot, isPackageDeclared } from "./model.js";
import { unbuiltSiblingSourceEntry } from "./workspace-source.js";
import { capturesEveryRootAbsoluteUrl } from "./tsconfig-aliases.js";
import { resolveTarget } from "./resolve.js";
import { isNuxtProject, nuxtPrepareGap, type NuxtPrepareGap } from "./nuxt.js";
import {
  declaredTransformOwner,
  detectMissingInstall,
  hardKindForTransformCode,
  preprocessorSearchFor,
  recognizeTransform,
  type PreflightKind,
  type PreprocessorSearch,
} from "./preflight-gates.js";

// Not "next/server-only": Next.js re-exports this package unchanged.
const SERVER_ONLY_PACKAGES = new Set(["server-only"]);

const NODE_BUILTINS = new Set(builtinModules);

export interface PreflightHit {
  kind: PreflightKind;
  // projectRoot-relative posix paths, measured file first.
  chain: string[];
  // The offending module specifier, for import-edge hits.
  specifier?: string;
  // Every chain that returned to an entry module, first one first.
  cycleChains?: string[][];
  // Recognizer code and the plugin family that owns the transform.
  transformCode?: string;
  transformOwner?: string;
  // The refusal may only claim "this project compiles that with X" when this is true.
  transformOwnerDeclared?: boolean;
  // Preprocessor refusals only: the search the walk performed, which the message reprints.
  preprocessor?: PreprocessorSearch;
  // Nuxt refusals only: the config that names a generated file and the file it names.
  nuxt?: NuxtPrepareGap;
  // Alias refusals only: the target the alias named, relative to projectRoot.
  aliasTarget?: string;
}

export interface PreflightResult {
  hard: PreflightHit[];
  soft: PreflightHit[];
  // Imports needing a project Vite plugin. Reported, never fatal: some still build.
  transforms: PreflightHit[];
  // Hooks that throw outside their provider: evidence for a render error, never a finding.
  providers: ProviderHit[];
}

// A missing provider is the most common reason a component that compiles renders nothing.
export const PROVIDER_LIBRARIES: Record<string, string> = {
  "next-intl": "useTranslations",
  "react-i18next": "useTranslation",
  "react-redux": "useSelector",
  "@tanstack/react-query": "useQuery",
  // Router and meta-framework hooks: the same failure shape as the four above.
  "react-router": "useNavigate",
  "react-router-dom": "useNavigate",
  "@remix-run/react": "useLoaderData",
  gatsby: "useStaticQuery",
  "@tanstack/react-router": "useRouter",
  "@tanstack/react-start": "useRouter",
};

// A headless kit ships one package per primitive, so PROVIDER_LIBRARIES's names do not fit.
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
  // The importing file's text. Without it the table's representative hook is named unconditionally.
  sourceText?: string,
): { source: string; hook?: string } | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return undefined;
  const pkg = packageOf(specifier);
  const hook = PROVIDER_LIBRARIES[pkg];
  if (hook) {
    // A file that imported only `Link` is not told about `useNavigate` it never called.
    const observed = sourceText === undefined || new RegExp(`\\b${hook}\\b`).test(sourceText);
    return observed ? { source: pkg, hook } : { source: pkg };
  }
  if (PROVIDER_LIBRARY_SCOPES.some((scope) => pkg.startsWith(scope))) return { source: pkg };
  return undefined;
}

// Text only: the point is to name a suspect, not to prove it.
export function detectLocalProviderModule(
  sourceText: string,
): { hook?: string } | undefined {
  if (!/createContext\s*[(<]/.test(sourceText)) return undefined;
  if (!/throw\s+new\s+[\w$]*Error\b/.test(sourceText)) return undefined;
  const hook = /\b(?:function|const|let|var)\s+(use[A-Z][\w$]*)/.exec(sourceText)?.[1];
  return hook ? { hook } : {};
}

// A wrapper around a headless-kit primitive has no local createContext and no local throw.
const EXPORTED_PROVIDER_COMPONENT =
  /export\s+(?:default\s+)?(?:async\s+)?function\s+(\w*Provider)\b|export\s+const\s+(\w*Provider)\s*[:=]/;
// The whole tag is captured and checked in JS: a trailing-literal regex misses the namespace.
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
  // React's own <XxxContext.Provider> ends in "Provider" too, so a local context is excluded.
  if (/createContext\s*[(<]/.test(sourceText)) return undefined;
  const exported = EXPORTED_PROVIDER_COMPONENT.exec(sourceText);
  if (!exported) return undefined;
  if (!hasJsxProviderElement(sourceText)) return undefined;
  const name = exported[1] ?? exported[2];
  // The component name fills the hook slot that rankProviderCandidates matches against.
  return name ? { hook: name } : {};
}

// A local hit's chain ends at the provider file; an external one ends one hop before the package.
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

// chain[0] is the seed the walk started from, so a wrapper-only hit is excluded, not mislabeled.
export function providersFromEntry(hits: ProviderHit[], entryRelative: string): ProviderHit[] {
  return hits.filter((hit) => hit.chain[0] === entryRelative);
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (fileName.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

// Keyed by mtime and size, so an edit invalidates the entry and a missing file is never cached.
const parsedFiles = new Map<string, { signature: string; sourceFile: ts.SourceFile | undefined }>();

// One cache per (project root, compiler options), so candidates 2 and 3 re-resolve nothing.
const moduleResolutionCaches = new Map<string, ts.ModuleResolutionCache>();

export function resetModuleResolutionCache(): void {
  moduleResolutionCaches.clear();
}

// The options carry the answer, so two projects that would resolve differently never share one.
function moduleResolutionCacheFor(
  projectRoot: string,
  compilerOptions: ts.CompilerOptions,
): ts.ModuleResolutionCache {
  const key = JSON.stringify([
    pathKey(projectRoot),
    Object.entries(compilerOptions)
      .filter(([, value]) => typeof value !== "function")
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ]);
  let cache = moduleResolutionCaches.get(key);
  if (cache === undefined) {
    cache = ts.createModuleResolutionCache(
      path.resolve(projectRoot),
      (fileName) => (ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase()),
      compilerOptions,
    );
    moduleResolutionCaches.set(key, cache);
  }
  return cache;
}

function fileSignature(fileName: string): string | undefined {
  try {
    const stat = fs.statSync(fileName);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
}

// A .vue file's imports live in its <script setup> block, or the walk stops at that file.
function parse(fileName: string, vueCompiler?: VueSfcCompiler): ts.SourceFile | undefined {
  // A compiler-less walk reads a .vue file as unreadable, so the two answers never share a key.
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

// TypeScript cannot resolve a .vue specifier, so SFC edges are resolved by hand.
function resolveVueImport(
  fromFile: string,
  specifier: string,
  compilerOptions?: ts.CompilerOptions,
): string | undefined {
  // An aliased SFC is the same graph edge as a relative one, so the alias is substituted here.
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
function aliasCandidates(
  specifier: string,
  compilerOptions?: ts.CompilerOptions,
  // A prefix-less key ("*", "/*") matches every bare specifier, so no refusal may rest on it.
  prefixedOnly = false,
): string[] {
  const paths = compilerOptions?.paths;
  // TypeScript 5 leaves baseUrl undefined for a paths-only tsconfig; pathsBasePath records it.
  const base =
    compilerOptions?.baseUrl ??
    (compilerOptions as { pathsBasePath?: string } | undefined)?.pathsBasePath ??
    (compilerOptions?.configFilePath
      ? path.dirname(compilerOptions.configFilePath as string)
      : undefined);
  if (!paths || !base) return [];
  const candidates: string[] = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    if (prefixedOnly && capturesEveryRootAbsoluteUrl(pattern)) continue;
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

// The target an alias named when nothing at all resolves; undefined when something does.
function missingAliasTarget(
  specifier: string,
  compilerOptions?: ts.CompilerOptions,
): string | undefined {
  const candidates = aliasCandidates(specifier, compilerOptions, true);
  if (candidates.length === 0) return undefined;
  for (const candidate of candidates) {
    if (resolveTarget(candidate) !== undefined) return undefined;
  }
  return candidates[0];
}


// A type-only statement is erased before a browser sees it, so it cannot break a mount.
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

// Only a leading directive prologue counts: a "use server" string elsewhere is just a string.
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

// An async function component is a React Server Component: a property of the source.
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
  return toPosix(path.relative(projectRoot, file));
}

export interface PreflightOptions {
  projectRoot: string;
  // The measured file, and the wrapper when active: a server-only import reaches both.
  entries: string[];
  componentName?: string;
  // The project's own SFC parser; absent, the walk stops at every .vue file.
  vueCompiler?: VueSfcCompiler;
}

export function runPreflight(options: PreflightOptions): PreflightResult {
  const { projectRoot, entries, vueCompiler } = options;

  const hard: PreflightHit[] = [];
  const soft: PreflightHit[] = [];
  const transforms: PreflightHit[] = [];
  const providers: ProviderHit[] = [];
  const providerSources = new Set<string>();
  const parents = new Map<string, string>();
  const cycleReported = new Set<string>();
  // One refusal per specifier, however many files in the graph import it.
  const reportedAliases = new Set<string>();
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

  // A PnP install or a Solid-only project cannot be fixed by walking, so both fail first.
  const entryChain = [relative(projectRoot, path.resolve(entries[0]))];
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  if (detectPnP(workspaceRoot)) {
    hard.push({ kind: "yarn-pnp", chain: entryChain });
  } else if (detectMissingInstall(projectRoot, workspaceRoot)) {
    hard.push({ kind: "not-installed", chain: entryChain });
  }
  // Declared, not available: a hard rejection must not fire on a transitive solid-js.
  const hasReact =
    isPackageDeclared("react", projectRoot, workspaceRoot) ||
    isPackageDeclared("react-dom", projectRoot, workspaceRoot);
  if (!hasReact && isPackageDeclared("solid-js", projectRoot, workspaceRoot)) {
    hard.push({ kind: "unsupported-framework", chain: entryChain, specifier: "solid-js" });
  }
  // Decidable from disk, and no component in the project escapes it, so it precedes the walk.
  if (isNuxtProject(projectRoot, workspaceRoot)) {
    const gap = nuxtPrepareGap(projectRoot);
    if (gap) hard.push({ kind: "nuxt-not-prepared", chain: entryChain, nuxt: gap });
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
    // Per importing file: a monorepo member and its sibling declare the same alias differently.
    const fileOptions = projectCompilerOptions(file);

    if (hasUseServerDirective(sf)) {
      hard.push({ kind: "use-server", chain: chainTo(file) });
    }

    // Only imported modules are candidates: a component creating its own context supplies it.
    if (!entryFiles.has(file)) {
      // One file is one candidate, whichever shape matches.
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

      const provider = detectProviderImport(edge.specifier, sf.text);
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
        // The recognizer's generic owner stands when the project declares no candidate.
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
        // A .vue edge is a graph edge too: the note must not end the walk here.
        if (recognizer.code === "vue" && vueCompiler) {
          const sfc = resolveVueImport(file, edge.specifier, fileOptions);
          if (sfc && !seen.has(sfc)) {
            seen.add(sfc);
            parents.set(sfc, file);
            queue.push(sfc);
          }
        }
        continue;
      }

      // Bare specifiers only: node_modules and `paths` targets do not appear while a run lives,
      // while a relative edge can — the harness writes its own entry into the measured project.
      const resolved = ts.resolveModuleName(
        edge.specifier,
        file,
        fileOptions,
        ts.sys,
        edge.specifier.startsWith(".") || edge.specifier.startsWith("/")
          ? undefined
          : moduleResolutionCacheFor(projectRoot, fileOptions),
      ).resolvedModule;
      const resolvedTarget =
        resolved === undefined ? undefined : path.normalize(resolved.resolvedFileName);
      // The graph stops at package boundaries: a dependency's internals are the bundler's job.
      const crossesPackageBoundary =
        resolvedTarget === undefined ||
        resolved!.isExternalLibraryImport ||
        /[\\/]node_modules[\\/]/.test(resolvedTarget) ||
        resolvedTarget.endsWith(".d.ts");
      // An unbuilt workspace sibling is first-party source: every gate applies behind its entry.
      const siblingSource = crossesPackageBoundary
        ? unbuiltSiblingSourceEntry(edge.specifier, file, projectRoot, workspaceRoot)
        : undefined;
      const target = crossesPackageBoundary
        ? siblingSource === undefined
          ? undefined
          : path.normalize(siblingSource)
        : resolvedTarget;
      if (target === undefined) {
        // An alias that matches and resolves nowhere is a 500 the dev server answers later.
        const missing =
          resolved === undefined ? missingAliasTarget(edge.specifier, fileOptions) : undefined;
        if (missing !== undefined && !reportedAliases.has(edge.specifier)) {
          reportedAliases.add(edge.specifier);
          hard.push({
            kind: "unresolved-alias",
            chain: chainTo(file),
            specifier: edge.specifier,
            aliasTarget: relative(projectRoot, missing),
          });
        }
        continue;
      }
      // The generated entry is the only root, so it enters a cycle where the app does not.
      if (entryFiles.has(target) && target !== file && !cycleReported.has(file)) {
        cycleReported.add(file);
        // page-errors.ts blames a TDZ page error on a cycle only when one was really found.
        setImportCycleReported(true);
        // One hit per run: a barrel with many importers differs only in its chains.
        cycleChains.push([...chainTo(file), relative(projectRoot, target)]);
      }
      if (seen.has(target)) continue;
      if (!fs.existsSync(target)) continue;

      seen.add(target);
      parents.set(target, file);
      queue.push(target);
    }
  }

  // chain stays the first one, so every consumer reads the same shape as any other hit.
  if (cycleChains.length > 0) {
    soft.push({ kind: "import-cycle", chain: cycleChains[0], cycleChains });
  }

  // Vue has no such shape: async setup() is a browser-side Suspense concern.
  if (
    options.componentName &&
    !isVueFile(entries[0]) &&
    detectAsyncComponent(entries[0], options.componentName)
  ) {
    hard.push({ kind: "async-component", chain: [relative(projectRoot, path.resolve(entries[0]))] });
  }

  // Last, so an earlier refusal stays the one the message names; the hit stays in transforms.
  for (const hit of transforms) {
    const kind = hit.transformCode ? hardKindForTransformCode(hit.transformCode) : undefined;
    if (kind) {
      hard.push({ ...hit, kind });
      continue;
    }
    if (hit.transformCode !== "css-preprocessor") continue;
    // Vite's own two search bases decide this, so it is settled without starting the server.
    const preprocessor = preprocessorSearchFor(hit, projectRoot, workspaceRoot);
    if (preprocessor) hard.push({ ...hit, kind: "unavailable-preprocessor", preprocessor });
  }

  return { hard, soft, transforms, providers };
}
