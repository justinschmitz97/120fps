import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import ts from "typescript";
import { projectCompilerOptions } from "./prop-gen.js";
import { isVueFile, parseSfcScript, type VueSfcCompiler } from "./vue-sfc.js";

// The marker package a server module imports to make the boundary explicit.
const SERVER_ONLY_PACKAGES = new Set(["server-only", "next/server-only"]);

const NODE_BUILTINS = new Set(builtinModules);

export type PreflightKind =
  | "server-only"
  | "use-server"
  | "async-component"
  | "node-builtin"
  // M48: an import whose compilation depends on a project Vite plugin the
  // harness deliberately does not load.
  | "project-transform";

// The harness never loads the project's vite.config (M30): its plugins target
// its own Vite major and its server options are not measurement-safe. That is
// the right architecture and the wrong error experience — a run would otherwise
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
  // project's Vite plugins. Reported, never fatal — some of these still build.
  transforms: PreflightHit[];
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (fileName.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

// M57: a `.vue` file is not TypeScript. Its `<script setup>` block is, and that
// is where its imports live — without this the walk would stop at the measured
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
  // is active — a server-only import reaches the browser through either.
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
  const parents = new Map<string, string>();
  const seen = new Set<string>();
  const queue: string[] = [];

  for (const entry of entries) {
    const abs = path.resolve(entry);
    if (seen.has(abs)) continue;
    seen.add(abs);
    queue.push(abs);
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

    for (const edge of importEdges(sf)) {
      if (edge.typeOnly) continue;

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
  // export shape — an SFC's component is an object, and `async setup()` is a
  // browser-side Suspense concern, not a server boundary.
  if (
    options.componentName &&
    !isVueFile(entries[0]) &&
    detectAsyncComponent(entries[0], options.componentName)
  ) {
    hard.push({ kind: "async-component", chain: [relative(projectRoot, path.resolve(entries[0]))] });
  }

  return { hard, soft, transforms };
}

function chainText(hit: PreflightHit): string {
  return hit.specifier ? [...hit.chain, hit.specifier].join(" → ") : hit.chain.join(" → ");
}

// Only the kinds that can be a hard failure. Node builtins and project
// transforms are reported, never fatal.
const HARD_CAUSE: Record<
  Exclude<PreflightKind, "node-builtin" | "project-transform">,
  string
> = {
  "server-only": "imports the server-only marker package",
  "use-server": "is a \"use server\" module",
  "async-component": "exports an async function component (a React Server Component)",
};

// The first hit is the one to fix: everything below it is unreachable until
// that edge moves.
export function preflightFailureMessage(hits: PreflightHit[]): string {
  const hit = hits[0];
  const where = hit.chain[hit.chain.length - 1];
  const cause = HARD_CAUSE[hit.kind as keyof typeof HARD_CAUSE];
  return [
    `Cannot measure this component in a browser: ${where} ${cause}.`,
    "",
    `  ${chainText(hit)}`,
    "",
    "Extract the client part below that boundary, or point 120fps at the client",
    "child component. Pass --no-preflight to attempt the run anyway.",
  ].join("\n");
}

export const NODE_BUILTIN_WARNING = (hit: PreflightHit): string =>
  `${chainText(hit)} — a Node builtin in the component graph. ` +
  "Vite may externalize it; if the run fails to boot, this is the first place to look.";

// Names the transform, not the symptom. Without this the run fails deep inside
// Vite with a message that never mentions the plugin the project relies on.
export const PROJECT_TRANSFORM_WARNING = (hit: PreflightHit): string =>
  `[transform:${hit.transformCode}] ${chainText(hit)} — this project compiles that with ` +
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
