import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// The compiler is never a 120fps dependency: the project's own Vue version is
// the one that must compile its own components (M27's React Compiler
// precedent). Under pnpm only `vue/compiler-sfc` resolves from a project that
// declares `vue` — `@vue/compiler-sfc` is a transitive dependency and is not
// linked at the top level. The bare package name is the npm/yarn fallback.
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
  ): { descriptor: { scriptSetup?: SfcBlock | null; script?: SfcBlock | null } };
}

export interface SfcScript {
  content: string;
  // "ts" | "tsx" | "js" | whatever the author wrote; "js" when unstated.
  lang: string;
}

export function isVueFile(filePath: string): boolean {
  return /\.vue$/i.test(filePath);
}

// Cached per lookup directory. Two entries (project root, component dir) cost
// one extra `require.resolve`; Node caches the module itself.
const compilerCache = new Map<string, Promise<VueSfcCompiler | undefined>>();

export function resetVueCompilerCache(): void {
  compilerCache.clear();
}

async function importVueCompiler(fromDir: string): Promise<VueSfcCompiler | undefined> {
  const projectRequire = createRequire(path.join(fromDir, "/"));
  for (const specifier of VUE_SFC_SPECIFIERS) {
    try {
      const resolved = projectRequire.resolve(specifier);
      const mod = await import(pathToFileURL(resolved).href);
      const candidate = (mod.parse ? mod : mod.default) as VueSfcCompiler | undefined;
      if (candidate && typeof candidate.parse === "function") return candidate;
    } catch {
      // Not installed under this name; try the next one.
    }
  }
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
  return (
    `Cannot read .vue components: neither ${VUE_SFC_SPECIFIERS.join(" nor ")} resolves from ` +
    `${projectRoot}. Install vue in the project — 120fps deliberately does not ship a Vue ` +
    "version of its own, so your components compile against the one they ship with."
  );
}

// `<script setup>` only. The Options API and plain-`<script>` SFCs mount fine
// (the plugin compiles them) but carry no `defineProps` type argument, so they
// extract no props — the same outcome as an untyped React component.
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
  return {
    content: block.content,
    lang: typeof block.lang === "string" ? block.lang : "js",
  };
}

// The virtual module the script block is type-checked as. Named `<sfc>.ts` in
// the SFC's own directory so relative imports, tsconfig `paths` and the
// checker's module resolution all behave exactly as they do for the real file.
// Only `tsx` needs a name of its own; JavaScript parses as TypeScript, and an
// untyped block contributes no declarations either way.
export function virtualScriptPath(vuePath: string, lang: string): string {
  return `${vuePath}.${lang === "tsx" ? "tsx" : "ts"}`;
}
