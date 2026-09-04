import fs from "node:fs";
import ts from "typescript";
import { resetWarnOnceCache } from "./extract.js";
import type { VirtualScripts } from "./vue.js";

// M36: a fresh ts.Program per extraction re-parses lib.d.ts and the project's
// node_modules type graph every time. Between calls only the component file
// differs, so parsed source files are cached for the process lifetime (keyed
// by options bucket + file stamp, mirroring the LanguageService document
// registry) and programs chain through `oldProgram` within an options bucket.
interface ExtractionCache {
  sourceFiles: Map<string, { sf: ts.SourceFile; mtimeMs: number; size: number }>;
  lastProgram?: ts.Program;
  lastOptionsKey?: string;
  programsCreated: number;
  sourceFilesParsed: number;
}


function emptyExtractionCache(): ExtractionCache {
  return { sourceFiles: new Map(), programsCreated: 0, sourceFilesParsed: 0 };
}


let extractionCache = emptyExtractionCache();


export function resetExtractionCache(): void {
  extractionCache = emptyExtractionCache();
  resetWarnOnceCache();
}


export function extractionCacheStats(): { programsCreated: number; sourceFilesParsed: number } {
  return {
    programsCreated: extractionCache.programsCreated,
    sourceFilesParsed: extractionCache.sourceFilesParsed,
  };
}


function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  return (
    "{" +
    Object.keys(value as object)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}


function fileStamp(fileName: string): { mtimeMs: number; size: number } | undefined {
  try {
    const st = fs.statSync(fileName);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return undefined;
  }
}


export function createCachedProgram(
  rootFile: string,
  options: ts.CompilerOptions,
  virtual?: VirtualScripts,
  // M97: a JS entry's sibling declaration, so the declaration's own symbols
  // bind in the same program the entry is checked in.
  extraRoots?: string[],
): ts.Program {
  const optionsKey = stableStringify(options);
  const host = ts.createCompilerHost(options);

  if (virtual) {
    const baseFileExists = host.fileExists.bind(host);
    const baseReadFile = host.readFile.bind(host);
    host.fileExists = (fileName) => virtual.has(fileName) || baseFileExists(fileName);
    host.readFile = (fileName) =>
      virtual.has(fileName) ? virtual.read(fileName) : baseReadFile(fileName);
  }

  const baseGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
    if (virtual?.has(fileName)) {
      return ts.createSourceFile(
        fileName,
        virtual.read(fileName) ?? "",
        ts.ScriptTarget.Latest,
        true,
        fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
    }
    const caseKey = ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase();
    // Bucketed by options like the document registry: a source file bound
    // under one options set is never reused under another.
    const key = optionsKey + "|" + caseKey;
    const stamp = fileStamp(fileName);
    const cached = extractionCache.sourceFiles.get(key);
    if (
      cached &&
      stamp &&
      !shouldCreateNewSourceFile &&
      cached.mtimeMs === stamp.mtimeMs &&
      cached.size === stamp.size
    ) {
      return cached.sf;
    }
    const sf = baseGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
    if (sf && stamp) {
      extractionCache.sourceFiles.set(key, { sf, mtimeMs: stamp.mtimeMs, size: stamp.size });
      extractionCache.sourceFilesParsed++;
    }
    return sf;
  };

  const oldProgram =
    extractionCache.lastOptionsKey === optionsKey ? extractionCache.lastProgram : undefined;
  const roots = extraRoots?.length ? [rootFile, ...extraRoots] : [rootFile];
  const program = ts.createProgram(roots, options, host, oldProgram);
  extractionCache.lastProgram = program;
  extractionCache.lastOptionsKey = optionsKey;
  extractionCache.programsCreated++;
  return program;
}
