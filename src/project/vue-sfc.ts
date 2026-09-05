import ts from "typescript";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Under pnpm only vue/compiler-sfc resolves; the bare package name is the npm/yarn fallback.
export const VUE_SFC_SPECIFIERS = ["vue/compiler-sfc", "@vue/compiler-sfc"];

export interface SfcBlock {
  content: string;
  lang?: string;
  attrs?: Record<string, string | true>;
  loc?: { start: { offset: number } };
}

export interface VueSfcCompiler {
  parse(
    source: string,
    options?: { filename?: string },
  ): {
    descriptor: { scriptSetup?: SfcBlock | null; script?: SfcBlock | null; template?: SfcBlock | null };
  };
}

export interface SfcScript {
  content: string;
  // "ts" | "tsx" | "js" | whatever the author wrote; "js" when unstated.
  lang: string;
  // A provide/inject hint may name that cause only from evidence the run read.
  usesInject: boolean;
}

// The lookbehind keeps useInject( and ctx.inject( out: only Vue's own injector counts.
const INJECT_CALL = /(?<![\w$.])inject\s*[<(]/;

// A commented-out inject( is not evidence the block makes that call.
const COMMENT = /\/\*[\s\S]*?\*\/|\/\/.*/g;

function callsInject(content: string): boolean {
  return INJECT_CALL.test(content.replace(COMMENT, " "));
}

export function isVueFile(filePath: string): boolean {
  return /\.vue$/i.test(filePath);
}

// Two entries (project root, component dir) cost one extra require.resolve.
const compilerCache = new Map<string, Promise<VueSfcCompiler | undefined>>();

export function resetVueCompilerCache(): void {
  compilerCache.clear();
  compilerFailures.clear();
}

// A bare catch {} would hide a fixture that resolves no compiler at all.
const compilerFailures = new Map<string, string[]>();

export function vueCompilerLoadFailures(fromDir: string): string[] {
  return compilerFailures.get(path.resolve(fromDir)) ?? [];
}

async function importVueCompiler(fromDir: string): Promise<VueSfcCompiler | undefined> {
  const projectRequire = createRequire(path.join(fromDir, "/"));
  const failures: string[] = [];
  for (const specifier of VUE_SFC_SPECIFIERS) {
    try {
      const resolved = projectRequire.resolve(specifier);
      const mod = await import(pathToFileURL(resolved).href);
      const candidate = (mod.parse ? mod : mod.default) as VueSfcCompiler | undefined;
      if (candidate && typeof candidate.parse === "function") {
        compilerFailures.delete(fromDir);
        return candidate;
      }
      failures.push(`${specifier}: resolved ${resolved} but it exports no parse function`);
    } catch (error) {
      failures.push(`${specifier}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
  compilerFailures.set(fromDir, failures);
  return undefined;
}

export async function loadVueCompiler(fromDir: string): Promise<VueSfcCompiler | undefined> {
  const key = path.resolve(fromDir);
  let entry = compilerCache.get(key);
  if (!entry) {
    entry = importVueCompiler(key);
    compilerCache.set(key, entry);
  }
  return entry;
}

export function VUE_COMPILER_MISSING(projectRoot: string): string {
  const failures = vueCompilerLoadFailures(projectRoot);
  return (
    `Cannot read .vue components: neither ${VUE_SFC_SPECIFIERS.join(" nor ")} resolves from ` +
    `${projectRoot}. Install vue in the project: 120fps deliberately does not ship a Vue ` +
    "version of its own, so your components compile against the one they ship with." +
    (failures.length > 0 ? ` Resolution reported: ${failures.join("; ")}.` : "")
  );
}

// The virtual file needs the one script kind that parses both blocks.
function strongerLang(setupLang: string | undefined, companionLang: string | undefined): string {
  const langs = [setupLang, companionLang].filter((lang): lang is string => typeof lang === "string");
  if (langs.includes("tsx")) return "tsx";
  // Handing JSX to a .ts virtual file stops it parsing.
  if (langs.includes("jsx") && langs.includes("ts")) return "tsx";
  if (langs.includes("ts")) return "ts";
  return setupLang ?? companionLang ?? "js";
}

// undefined is load-bearing: extractVueProps (props/vue.ts) reads it as Options-API candidate.
export function parseSfcScript(
  source: string,
  filename: string,
  compiler: VueSfcCompiler,
): SfcScript | undefined {
  let descriptor;
  try {
    descriptor = compiler.parse(source, { filename }).descriptor;
  } catch {
    // A malformed SFC is the plugin's error to report, with real positions.
    return undefined;
  }
  const block = descriptor?.scriptSetup;
  if (!block || typeof block.content !== "string") return undefined;
  const companion = descriptor?.script;
  const companionContent = typeof companion?.content === "string" ? companion.content : "";
  // A companion <script> is the only place an SFC can export interface its props type.
  const content = companionContent.trim() ? `${companionContent}\n${block.content}` : block.content;
  return {
    content,
    // Read once here, so the hint rests on the same text the props extraction read.
    usesInject: callsInject(content),
    lang: strongerLang(
      typeof block.lang === "string" ? block.lang : undefined,
      typeof companion?.lang === "string" ? companion.lang : undefined,
    ),
  };
}

// Tells "genuinely no props" from "props in a form ADR 0002 excludes" for an SFC with no setup.
export function detectOptionsApiProps(
  source: string,
  filename: string,
  compiler: VueSfcCompiler,
): "props" | "setup-props" | "extends" | "mixins" | undefined {
  let descriptor;
  try {
    descriptor = compiler.parse(source, { filename }).descriptor;
  } catch {
    // A malformed SFC is the plugin's error to report, with real positions.
    return undefined;
  }
  const block = descriptor?.script;
  if (!block || typeof block.content !== "string" || block.content.trim() === "") return undefined;

  // Shallow by design: the top-level default export only, no evaluation of the Options object.
  const scriptFile = ts.createSourceFile(filename, block.content, ts.ScriptTarget.Latest, false);
  const literal = defaultExportObjectLiteral(scriptFile);
  if (!literal) return undefined;

  const keys = new Set<string>();
  for (const property of literal.properties) {
    const name = objectLiteralPropertyName(property);
    if (name) keys.add(name);
  }

  // A component's own runtime props object is the most direct evidence; inheritance a fallback.
  if (keys.has("props")) return keys.has("setup") ? "setup-props" : "props";
  if (keys.has("extends")) return "extends";
  if (keys.has("mixins")) return "mixins";
  return undefined;
}

function objectLiteralPropertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  if (
    !ts.isPropertyAssignment(property) &&
    !ts.isShorthandPropertyAssignment(property) &&
    !ts.isMethodDeclaration(property)
  ) {
    return undefined;
  }
  const name = property.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

// A wrapper call declares nothing, so only its first argument is inspected.
function defaultExportObjectLiteral(
  sourceFile: ts.SourceFile,
): ts.ObjectLiteralExpression | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isExportAssignment(statement) || statement.isExportEquals) continue;
    const expression = statement.expression;
    if (ts.isObjectLiteralExpression(expression)) return expression;
    if (ts.isCallExpression(expression) && expression.arguments.length > 0) {
      const first = expression.arguments[0];
      if (ts.isObjectLiteralExpression(first)) return first;
    }
  }
  return undefined;
}

// An unconditional root reporting zero DOM is the harness's miscount (harness/entry.ts).
const CONDITIONAL_ROOT_DIRECTIVE = /\bv-if\s*=|\bv-show\s*=|\bv-for\s*=/;

export function templateHasUnconditionalRoot(
  source: string,
  filename: string,
  compiler: VueSfcCompiler,
): boolean {
  let descriptor;
  try {
    descriptor = compiler.parse(source, { filename }).descriptor;
  } catch {
    // A malformed SFC is the plugin's error to report; no special handling.
    return false;
  }
  const template = descriptor?.template;
  if (!template || typeof template.content !== "string") return false;
  const match = /<([a-zA-Z][\w-]*)\b([^>]*)>/.exec(template.content);
  if (!match) return false;
  return !CONDITIONAL_ROOT_DIRECTIVE.test(match[2]);
}

// Named in the SFC's own directory so relative imports and paths resolve as for the real file.
export function virtualScriptPath(vuePath: string, lang: string): string {
  return `${vuePath}.${lang === "tsx" ? "tsx" : "ts"}`;
}
