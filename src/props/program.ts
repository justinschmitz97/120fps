import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { findProjectRoot, findWorkspaceRoot, resolveGoverningTsconfig } from "../project/index.js";
import { isBooleanUnion, nonUndefinedMembers } from "./classify.js";
import { resetWarnOnceCache } from "./extract.js";
import { detectPropPresets, loadPropPresets } from "./presets.js";
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

const NODE_MODULES = /[\\/]node_modules[\\/]/;

const NOISE_PROP_NAME = /^(aria-|data-)/;


// M60: past this the props type is a DOM surface that slipped the filter, not a
// component's own contract.
export const MAX_PROPS = 32;


function isLocalDeclaration(decl: ts.Declaration): boolean {
  return !NODE_MODULES.test(decl.getSourceFile().fileName);
}


// M81: `isNoiseProp` still fully filters ambient (default-lib/@types-react)
// declarations for NESTED object-value synthesis (`synthesizeValue`), where an
// unbounded width would balloon a synthesized object with ~300 DOM/ARIA
// members no one asked for. The top-level prop schema no longer uses it: an
// ambient declaration site does not mean the member is noise (`onClick`,
// `disabled`, `children` are declared there exactly like `aria-activedescendant`
// is), so `typeToSchema` only applies the hard, silent `aria-`/`data-` filter
// and ranks everything else instead of erasing it pre-cap.
export function isNoiseName(name: string): boolean {
  return NOISE_PROP_NAME.test(name);
}


// M81 section 1: a prop named `/^on[A-Z]/` whose type carries a call
// signature (an event handler), or named exactly `children`, is locally
// meaningful regardless of where it is declared.
const EVENT_HANDLER_NAME = /^on[A-Z]/;


// M86: props the cap must never rank away — the target's own source
// referenced them by name, or a `<stem>.props.tsx` preset names them. Both
// are read once per extraction and merged into one promoted-name set;
// `propRank` checks it before any type-shape test.
export function presetPropNames(fileName: string): Set<string> {
  const presetPath = detectPropPresets(fileName);
  if (!presetPath) return new Set();
  const presets = loadPropPresets(presetPath, path.dirname(presetPath));
  return presets ? new Set(presets.entries.keys()) : new Set();
}


// M81 section 1 (M86 adds Tier 0): four-tier rank computed over the props the
// cap has to choose among, stable within each tier.
// Tier 0 - promoted: the target's own source references this name, or a
//          preset names it. Neither signal depends on how the prop's TYPE
//          resolves, so an unresolved generic parameter cannot defeat it.
// Tier 1 - variant surface: a plain boolean or finite literal union on the
//          prop's own type - reuses the same cheap type-flag tests
//          `classifyType` uses later, so it is affordable to run over every
//          kept prop, not just the 32 survivors.
// Tier 2 - locally meaningful: `declaredHere` today, a computed/mapped-type
//          member with zero declarations (there is no declaration site to be
//          third-party at), or an event-handler/`children` name reached only
//          through an ambient declaration.
// Tier 3 - everything else: declared exclusively in node_modules, not
//          variant-shaped - today's tail behavior, unchanged.
// M103 (chakra-ui-F1, heroui-F3, dub-F7): origin decides before shape. M81's
// Tier 1 was shape only, so an inherited `translate?: "yes" | "no"` and an
// inherited `hidden?: boolean` outranked every prop the component itself
// declares whose type resolves to something less tidy -- chakra's Badge
// measured 32 props of which none were Badge's. See M103 in
// specs/overview/02-milestones.md.
export type PropRank = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;


// M103: how many members the interface or type literal that declares a prop
// declares. A component's own props interface is small (heroui's
// `BadgeRootProps` has six members); a DOM attribute surface
// (`HTMLAttributes`, ~250) and a style system's generated CSS-property surface
// (chakra's `SystemProperties`, ~300) are not. "Declared in the project's own
// sources" alone does not separate chakra's three recipe props from the three
// hundred style props declared beside them in the same package; width does.
const WIDE_DECLARATION_MEMBERS = 40;


// M103 (chakra-F1): the names design systems reserve for their own variant
// axes. Deliberately short and closed -- each one is a name a user varies to
// change how the component looks, and none of them is a DOM attribute.
const KNOWN_VARIANT_AXIS_NAMES = new Set([
  "colorPalette",
  "colorScheme",
  "variant",
  "size",
  "tone",
  "intent",
  "appearance",
  "severity",
  "status",
]);


function isNarrowDeclarationSite(decl: ts.Declaration): boolean {
  const parent = decl.parent;
  if (!parent) return true;
  if (ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent)) {
    return parent.members.length < WIDE_DECLARATION_MEMBERS;
  }
  if (ts.isTypeLiteralNode(parent)) return parent.members.length < WIDE_DECLARATION_MEMBERS;
  return true;
}


export function propRank(
  prop: ts.Symbol,
  checker: ts.TypeChecker,
  promotedNames: Set<string>,
): PropRank {
  const name = prop.getName();
  if (promotedNames.has(name)) return 0;

  const decls = prop.getDeclarations();
  const decl = decls?.[0];
  const type = decl ? checker.getTypeOfSymbolAtLocation(prop, decl) : checker.getTypeOfSymbol(prop);
  const nonUndefined = nonUndefinedMembers(type);
  const target = nonUndefined.length === 1 ? nonUndefined[0] : type;

  // M103 (chakra-F1, corpus re-test): a design system declares its own variant
  // surface inside the same generated interface as its three hundred style
  // props, so origin, width and shape cannot separate `colorPalette` from
  // `clipPath`. The name can: these are the names a component library reserves
  // for the axes a user actually varies. Promoted only when the prop carries a
  // string-like type, so a same-named callback or object prop is unaffected.
  const isStringLike = nonUndefined.some(
    (member) =>
      !!(member.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)) ||
      member.isStringLiteral(),
  );

  const isVariantSurface =
    !!(target.flags & ts.TypeFlags.BooleanLike) ||
    isBooleanUnion(nonUndefined) ||
    (nonUndefined.length > 1 &&
      nonUndefined.every((m) => m.isStringLiteral() || !!(m.flags & ts.TypeFlags.StringLiteral))) ||
    (nonUndefined.length > 1 &&
      nonUndefined.every((m) => m.isNumberLiteral() || !!(m.flags & ts.TypeFlags.NumberLiteral)));

  if (KNOWN_VARIANT_AXIS_NAMES.has(name) && (isVariantSurface || isStringLike)) {
    return isVariantSurface ? 1 : 2;
  }

  // Declared in the project's own sources: the component's file, a local type
  // alias, or the package's generated recipe/variant types. A narrow
  // declaration site is the component's own surface; a wide one is a bulk
  // style/attribute surface that happens to live in the same package.
  if (decls && decls.length > 0 && decls.some(isLocalDeclaration)) {
    const narrow = decls.some((d) => isLocalDeclaration(d) && isNarrowDeclarationSite(d));
    if (narrow) return isVariantSurface ? 1 : 2;
    return isVariantSurface ? 4 : 5;
  }

  // A mapped or computed member has no declaration site to be third-party at,
  // and it is exactly the shape `RecipeProps<"badge">`/`VariantProps<typeof x>`
  // produce.
  if (!decls || decls.length === 0) return 3;

  if (isVariantSurface) return 6;

  // M86 mechanism 1: an unresolved generic parameter can make
  // `getCallSignatures()` report zero for a genuinely callable type (a
  // handler prop typed through `IntrinsicElements[E]`-style indirection with
  // `E` unbound). Extensive probing against polymorphic-element and
  // conditional-type shapes did not reproduce a real function type losing its
  // call signatures this way — see `m86-prop-selection-keeps-what-matters.md`
  // `## open` — but the failure signature such a defeat would most plausibly
  // produce (the type resolving to `any`/`unknown` rather than a concrete
  // non-callable type) is cheap and low-risk to also promote: a
  // deliberately-non-function prop named `/^on[A-Z]/` resolves to a concrete
  // type, not `any`/`unknown`.
  const isHandlerOrChildren =
    name === "children" ||
    (EVENT_HANDLER_NAME.test(name) &&
      (nonUndefined.some((t) => t.getCallSignatures().length > 0) ||
        nonUndefined.some((t) => t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))));
  if (isHandlerOrChildren) return 7;

  return 8;
}


// One warning per tsconfig path per process (M24 D6).
const warnedTsconfigPaths = new Set<string>();


function warnTsconfigOnce(configPath: string, detail: string): void {
  if (warnedTsconfigPaths.has(configPath)) return;
  warnedTsconfigPaths.add(configPath);
  process.stderr.write(`Warning: problem reading tsconfig at ${configPath}: ${detail}\n`);
}


// The same options prop extraction resolves under, so a preflight walk follows
// the same tsconfig paths the measured graph does.
export function projectCompilerOptions(absolutePath: string): ts.CompilerOptions {
  return createCompilerOptions(path.resolve(absolutePath));
}


// The reader keeps quiet about a config it could not read, so the caller that
// asked prints the message once. Its sentence names the path this function
// already has, so the path is not repeated inside the detail.
function readFailureDetail(warnings: string[], configPath: string): string {
  const marker = `could not parse tsconfig at ${configPath}: `;
  const failure = warnings.find((warning) => warning.startsWith(marker));
  return failure ? failure.slice(marker.length) : (warnings[0] ?? "the config could not be read");
}


// The reader surfaces only the diagnostics the run discloses (a broken extends
// chain). An option declared with the wrong value type has warned here once per
// config since M24 and still does, read from the governing config's own
// compilerOptions without globbing the project's files a second time.
function declaredOptionDiagnostic(configPath: string): string | undefined {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const raw = configFile.config as { compilerOptions?: unknown } | undefined;
  const declared = raw?.compilerOptions;
  if (configFile.error || declared === null || typeof declared !== "object") return undefined;
  const converted = ts.convertCompilerOptionsFromJson(
    declared,
    path.dirname(configPath),
    configPath,
  );
  if (converted.errors.length > 0) {
    return ts.flattenDiagnosticMessageText(converted.errors[0].messageText, " ");
  }
  // A malformed include/files key, or an invalid option inside an extends base,
  // never reaches convertCompilerOptionsFromJson. Parsing without globbing
  // surfaces it; 18003 only says the fixture has no input files.
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    { ...ts.sys, readDirectory: () => [] },
    path.dirname(configPath),
    undefined,
    configPath,
  );
  const other = parsed.errors.find((diagnostic) => diagnostic.code !== 18003);
  return other ? ts.flattenDiagnosticMessageText(other.messageText, " ") : undefined;
}


export function createCompilerOptions(absolutePath: string): ts.CompilerOptions {
  // M69: the same search the harness builds aliases from, so one config
  // governs both. The bound is the workspace root; a tree with no package.json
  // anywhere has no project model, and the walk keeps its old reach.
  // M109 (I1): through the shared reader, so a references-only root hands
  // extraction the referenced config that covers this file, which is the
  // config the harness aliases and the dev server resolve from.
  const startDir = path.dirname(absolutePath);
  const memberRoot = findProjectRoot(startDir);
  const governing = resolveGoverningTsconfig(
    absolutePath,
    memberRoot === undefined ? undefined : findWorkspaceRoot(memberRoot),
  );
  const tsconfigPath = governing.configPath;

  let compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
    skipLibCheck: true,
    // A .jsx target is outside the program without this, so extraction has no
    // source file to read and reports the component as unparsable.
    allowJs: true,
  };

  if (governing.nearestConfigPath && !tsconfigPath) {
    // B2: a config that could not be read keeps its one warning, and
    // extraction continues on the defaults above.
    warnTsconfigOnce(
      governing.nearestConfigPath,
      readFailureDetail(governing.warnings, governing.nearestConfigPath),
    );
  } else if (tsconfigPath) {
    if (!warnedTsconfigPaths.has(tsconfigPath)) {
      const optionDetail = declaredOptionDiagnostic(tsconfigPath);
      if (optionDetail) warnTsconfigOnce(tsconfigPath, optionDetail);
    }
    // Override resolution to Bundler: user components use extensionless imports
    compilerOptions = {
      ...governing.options,
      skipLibCheck: true,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
      // The measured file is named by the user: a project that excludes
      // JavaScript from type checking still gets its .jsx component read.
      allowJs: true,
    };
  }

  return compilerOptions;
}
