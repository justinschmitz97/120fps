import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { escapeRegex, isDirectory, isFile, toPosix } from "../shared/index.js";
import {
  findProjectRoot,
  findWorkspaceRoot,
  installedPackageDir,
  readProjectManifest,
} from "../project/index.js";
import { resolveManifestEntry } from "./bundler-failure.js";

// Probe order decides which file answers; `.ts` first matches what a project
// with two configs lying around is actually built with.
const VITE_CONFIG_FILES = [
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.cts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
];

// Ordered so the warning reads the same however the config file was written.
const IGNORED_KEY_ORDER = [
  "a computed config object",
  "root",
  "publicDir",
  "resolve.alias",
  "css.preprocessorOptions",
  "plugins",
];

export interface ViteConfigData {
  configFile?: string;
  // M114 A3 (vuetify-F1): the directory the config makes Vite's root, when a
  // text read can fold it. Absent when the config declares none or computes
  // one, and then "root" is among `ignoredKeys`.
  root?: string;
  // M114 A5: the html files `build.rollupOptions.input` names, folded and
  // confirmed on disk, in the config's own order.
  rollupInputs?: string[];
  publicDir?: string;
  aliases: Array<{ find: RegExp; replacement: string }>;
  ignoredKeys: string[];
  // M117 A3 (I10): the plugins the config declares, in the config's own order,
  // named as the config writes them. Absent when it declares none.
  pluginNames?: string[];
  // M76: resolve.conditions read from the member layer, or the workspace
  // root's when the member declares none.
  conditions: string[];
  // M76: workspace-root-sourced merges, disclosed eagerly at merge time (a
  // hand-written resolve.alias/resolve.conditions object is a short,
  // deliberately curated list, unlike a generated tsconfig `paths` map).
  warnings: string[];
  // M106 A3 (twenty-F2): the foldable half of css.preprocessorOptions, keyed by
  // language, ready to hand to the harness server's own `css` option.
  preprocessorOptions?: PreprocessorOptions;
}

// Only what a text read can prove: a string that needs no evaluation, and a
// path that exists.
export interface PreprocessorLangOptions {
  additionalData?: string;
  loadPaths?: string[];
  includePaths?: string[];
}

export type PreprocessorOptions = Record<string, PreprocessorLangOptions>;

// M106 A3: an option the harness read and cannot replay, named as itself. The
// blanket "additionalData is not replicated" line (VITE_CONFIG_IGNORED_WARNING)
// stays for the case where additionalData really was unfoldable; a project
// whose additionalData folds fine but whose `api` selects a Sass flavour gets
// this instead, because the old sentence would be false for it.
export function VITE_CONFIG_PREPROCESSOR_OPTION_WARNING(
  configFile: string,
  options: string[],
): string {
  return (
    `${configFile} declares ${options.join(", ")}, which the harness read but cannot honor: the ` +
    "project's Vite config is never executed, and these options select behaviour rather than " +
    "content. Everything else under css.preprocessorOptions (additionalData, loadPaths) is replayed."
  );
}

// M117 A3: a note that named the key `plugins` and none of the plugins left a
// reader unable to tell whether the harness dropped anything that mattered.
// With the names in hand the note states what it dropped; without them (a
// `plugins` value that is not an array literal) the key-only wording stands.
function VITE_CONFIG_DROPPED_PLUGINS_CLAUSE(
  configFile: string,
  keys: string[],
  pluginNames: string[],
): string {
  const others = keys.filter((key) => key !== "plugins");
  const declared = others.length > 0 ? `${others.join(", ")} and plugins` : "plugins";
  return (
    `${configFile} declares ${declared} the harness cannot honor: ${pluginNames.join(", ")} — ` +
    "the project's Vite config is never executed"
  );
}

export function VITE_CONFIG_IGNORED_WARNING(
  configFile: string,
  keys: string[],
  pluginNames?: string[],
): string {
  const base =
    pluginNames && pluginNames.length > 0 && keys.includes("plugins")
      ? VITE_CONFIG_DROPPED_PLUGINS_CLAUSE(configFile, keys, pluginNames)
      : `${configFile} declares ${keys.join(", ")}, which the harness read but cannot honor: the project's ` +
        "Vite config is never executed";
  return keys.includes("css.preprocessorOptions")
    ? `${base}; preprocessor globals (additionalData) are not replicated, so Sass or Less variables ` +
        "injected there are missing"
    : base;
}

export function VITE_CONFIG_WORKSPACE_ROOT_ALIAS_WARNING(
  key: string,
  replacement: string,
  configFile: string,
  // M105 (chakra-ui-F6): the disclosure said where the alias came from and
  // never why it is load-bearing. When the aliased package's own manifest
  // points at an entry that has not been built, the alias is the only reason
  // anything resolves at all, and a user removing it gets a resolution failure.
  missingDeclaredEntry?: string,
): string {
  return (
    `resolve.alias "${key}" -> "${replacement}" came from the workspace root's ${configFile}, ` +
    "not the project's own vite.config" +
    (missingDeclaredEntry
      ? `; without it "${key}" would not resolve at all: its package.json points at ` +
        `${missingDeclaredEntry}, which this workspace has not built`
      : "")
  );
}

// The entry the installed package's own manifest declares, when that file does
// not exist. Undefined for a package that is absent, has no manifest, or
// declares an entry that is really there — nothing is claimed without reading it.
export function aliasedPackageMissingEntry(
  specifier: string,
  projectRoot: string,
  // The alias target. A workspace package aliased to its own source
  // (chakra-ui's `@chakra-ui/react` -> `packages/react/src`) is never under
  // node_modules at all: the package whose entry is missing is the one that
  // owns the target directory.
  replacement?: string,
): string | undefined {
  const pkg = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
  const pkgDir =
    installedPackageDir(pkg, projectRoot) ??
    (replacement ? findProjectRoot(path.resolve(replacement)) : undefined);
  if (!pkgDir) return undefined;
  const manifest = readProjectManifest(pkgDir);
  if (manifest && manifest.name !== undefined && manifest.name !== pkg) return undefined;
  if (!manifest) return undefined;
  const declared = resolveManifestEntry(manifest);
  const entry =
    declared ??
    [manifest.module, manifest.main, manifest.types].find(
      (value): value is string => typeof value === "string",
    );
  if (!entry) return undefined;
  const resolved = path.resolve(pkgDir, entry);
  if (isFile(resolved)) return undefined;
  return toPosix(resolved);
}

export function VITE_CONFIG_WORKSPACE_ROOT_CONDITIONS_WARNING(
  conditions: string[],
  configFile: string,
): string {
  return (
    `resolve.conditions [${conditions.join(", ")}] came from the workspace root's ${configFile}, ` +
    "not the project's own vite.config, and changes which package export is served for every bare " +
    "import in this run"
  );
}

export function literalPropertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  const name = property.name;
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

export function stringLiteralValue(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

// M93 (chakra-ui-F1): a resolve.alias value written as `resolve("packages/react/src")`
// or `resolve(__dirname, "packages/react/src")` (bare `resolve`/`join`, or the
// `path.resolve`/`path.join` member-expression form) is a call expression, not
// a string literal -- the only shape the plain check above recognizes.
// Recognized here without importing or running anything: the callee's name is
// read syntactically, and only its string-literal arguments are collected, in
// order. A non-literal argument such as `__dirname` is simply skipped, because
// `configDir` (the base every literal is resolved against below) already is
// what `__dirname` would evaluate to inside this file, so omitting it from the
// collected literals does not change the resolved result. A call with no
// callee name of `resolve`/`join`, or with no string-literal arguments at
// all, is left unrecognized (falls through to the caller's own "ignored"
// handling).
function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) return expr.name.text;
  return undefined;
}

// M106 A3: a string a text read can prove, in the four shapes the corpus
// writes: a literal, a template with nothing to substitute, `[...].join(sep)`
// over such parts, and `+` concatenation of them. Anything else (a function, a
// variable, an interpolation) is not folded — undefined, never a guess.
// Review A5: what a user has to look at in their own config. Named after the
// shape, never the syntax-kind number.
function expressionShape(node: ts.Expression): string {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return "function";
  if (ts.isIdentifier(node)) return "a variable";
  if (ts.isTemplateExpression(node)) return "an interpolated template";
  if (ts.isCallExpression(node)) return "a call";
  if (ts.isObjectLiteralExpression(node)) return "an object";
  if (ts.isArrayLiteralExpression(node)) return "an array";
  return "an expression";
}

export function foldStringExpression(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return foldStringExpression(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = foldStringExpression(node.left);
    const right = foldStringExpression(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "join" &&
    ts.isArrayLiteralExpression(node.expression.expression)
  ) {
    const separator = node.arguments.length === 0 ? "," : foldStringExpression(node.arguments[0]);
    if (separator === undefined) return undefined;
    const parts = node.expression.expression.elements.map((el) => foldStringExpression(el));
    if (parts.some((part) => part === undefined)) return undefined;
    return parts.join(separator);
  }
  return undefined;
}

// Directory entries, resolved through the same call-expression reader the
// alias branch uses, and kept only when they exist: a loadPath that is not
// there changes nothing for sass but would make this report a path it never
// verified.
export function foldPathArray(node: ts.Expression, configDir: string): string[] {
  if (!ts.isArrayLiteralExpression(node)) return [];
  const dirs: string[] = [];
  for (const element of node.elements) {
    const literal = stringLiteralValue(element);
    const resolved =
      literal !== undefined
        ? path.resolve(configDir, literal)
        : resolveCallExpressionPath(element, configDir);
    if (resolved && isDirectory(resolved) && !dirs.includes(resolved)) dirs.push(resolved);
  }
  return dirs;
}

// An argument whose value the config text states outright: a string literal,
// or `__dirname`, which is the config's own directory and so already the base
// every fold resolves against.
function isFoldableCallArgument(arg: ts.Expression): boolean {
  if (stringLiteralValue(arg) !== undefined) return true;
  return ts.isIdentifier(arg) && arg.text === "__dirname";
}

function resolveCallExpressionPath(node: ts.Expression, configDir: string): string | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const name = calleeName(node.expression);
  if (name !== "resolve" && name !== "join") return undefined;
  const literalArgs = node.arguments
    .map((arg) => stringLiteralValue(arg))
    .filter((v): v is string => v !== undefined);
  if (literalArgs.length === 0) return undefined;
  return path.resolve(configDir, ...literalArgs);
}

// M114 A5: `build.rollupOptions.input`, in the four shapes a config writes it
// — one path, an array of paths, an object map of them, each a string literal
// or a `resolve(...)`/`join(...)` call. Only html files that exist survive: an
// entry the run cannot open is not an entry. Relative paths fold against the
// config's own directory, the form every corpus config uses; a path relative
// to a declared `root` instead simply does not resolve and is dropped.
function foldRollupInputs(build: ts.ObjectLiteralExpression, configDir: string): string[] {
  const rollupOptions = build.properties.find(
    (property) => literalPropertyName(property) === "rollupOptions",
  );
  if (!rollupOptions || !ts.isPropertyAssignment(rollupOptions)) return [];
  if (!ts.isObjectLiteralExpression(rollupOptions.initializer)) return [];
  const input = rollupOptions.initializer.properties.find(
    (property) => literalPropertyName(property) === "input",
  );
  if (!input || !ts.isPropertyAssignment(input)) return [];

  const expressions: ts.Expression[] = [];
  const value = input.initializer;
  if (ts.isArrayLiteralExpression(value)) expressions.push(...value.elements);
  else if (ts.isObjectLiteralExpression(value)) {
    for (const entry of value.properties) {
      if (ts.isPropertyAssignment(entry)) expressions.push(entry.initializer);
    }
  } else expressions.push(value);

  const files: string[] = [];
  for (const expression of expressions) {
    const literal = stringLiteralValue(expression);
    const resolved =
      literal === undefined
        ? resolveCallExpressionPath(expression, configDir)
        : path.resolve(configDir, literal);
    if (!resolved || !/\.html?$/i.test(resolved) || !isFile(resolved)) continue;
    if (!files.includes(resolved)) files.push(resolved);
  }
  return files;
}

// The exported config object, through the shapes a config file is written in.
// Nothing is called and nothing is imported: this is the text of a file the
// harness must never execute.
function findViteConfigObject(source: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  const unwrap = (node: ts.Expression | undefined, depth = 0): ts.ObjectLiteralExpression | undefined => {
    if (!node || depth > 4) return undefined;
    if (ts.isObjectLiteralExpression(node)) return node;
    if (ts.isParenthesizedExpression(node)) return unwrap(node.expression, depth + 1);
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      return unwrap(node.expression, depth + 1);
    }
    if (ts.isCallExpression(node)) return unwrap(node.arguments[0], depth + 1);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const body = node.body;
      if (ts.isBlock(body)) {
        for (const statement of body.statements) {
          if (ts.isReturnStatement(statement)) return unwrap(statement.expression, depth + 1);
        }
        return undefined;
      }
      return unwrap(body, depth + 1);
    }
    return undefined;
  };

  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      return unwrap(statement.expression);
    }
    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      statement.expression.left.getText(source).replace(/\s/g, "") === "module.exports"
    ) {
      return unwrap(statement.expression.right);
    }
  }
  return undefined;
}

// M117 A3: a call expression by its callee, an object literal by its `name`,
// anything else by where it sits in the array. Text only: M71's invariant is
// that a project's vite.config is read and never executed.
function declaredPluginName(element: ts.Expression, index: number): string {
  const positional = `unnamed plugin #${index + 1}`;
  if (ts.isCallExpression(element)) {
    const callee = element.expression;
    return ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee)
      ? callee.getText().replace(/\s+/g, "")
      : positional;
  }
  if (ts.isObjectLiteralExpression(element)) {
    for (const property of element.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      if (literalPropertyName(property) !== "name") continue;
      const value = stringLiteralValue(property.initializer);
      if (value !== undefined) return value;
    }
  }
  return positional;
}

function findViteConfigFile(dir: string): string | undefined {
  for (const name of VITE_CONFIG_FILES) {
    const candidate = path.join(dir, name);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

interface ParsedViteConfig {
  // M114 A3, A5
  root?: string;
  rollupInputs?: string[];
  publicDir?: string;
  aliasEntries: Array<{ find: string; replacement: string }>;
  conditions: string[];
  ignored: Set<string>;
  // M117 A3
  pluginNames?: string[];
  // M106 A3 (twenty-F2)
  preprocessorOptions?: PreprocessorOptions;
  unfoldablePreprocessor?: string[];
}

// One config file's text, read and parsed the same way regardless of which
// layer (member or workspace root, M76) is asking. Never imported: this stays
// inside M71's contract that a project's vite.config is never executed.
function parseViteConfigFile(configFile: string): ParsedViteConfig | undefined {
  let text: string;
  try {
    text = fs.readFileSync(configFile, "utf-8");
  } catch {
    return undefined;
  }

  const ignored = new Set<string>();
  let pluginNames: string[] | undefined;
  const source = ts.createSourceFile(configFile, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const config = findViteConfigObject(source);
  if (!config) {
    ignored.add("a computed config object");
    return { aliasEntries: [], conditions: [], ignored };
  }

  const configDir = path.dirname(configFile);
  const aliasEntries: Array<{ find: string; replacement: string }> = [];
  let conditions: string[] = [];
  let publicDir: string | undefined;
  let root: string | undefined;
  let rollupInputs: string[] | undefined;
  const preprocessorOptions: PreprocessorOptions = {};
  const unfoldable: string[] = [];

  for (const property of config.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = literalPropertyName(property);

    // M114 A3 (vuetify-F1): vuetify's own `root: resolve('dev')` decides where
    // its index.html is, and the loop had no branch for it, so the run
    // asserted the package has no application entry.
    if (name === "root") {
      const literal = stringLiteralValue(property.initializer);
      // M114 A3 review: `resolve(process.env.APP_ROOT, "dev")` folds to
      // <configDir>/dev once the non-literal argument is dropped, which would
      // name a root the config never declared. A call folds only when every
      // argument is readable from the config text.
      if (
        literal === undefined &&
        ts.isCallExpression(property.initializer) &&
        !property.initializer.arguments.every(isFoldableCallArgument)
      ) {
        ignored.add("root");
        continue;
      }
      const resolved =
        literal === undefined
          ? resolveCallExpressionPath(property.initializer, configDir)
          : path.resolve(configDir, literal);
      if (resolved && isDirectory(resolved)) root = resolved;
      else ignored.add("root");
      continue;
    }

    // M114 A5: the html file the project builds from, when the path folds.
    if (name === "build" && ts.isObjectLiteralExpression(property.initializer)) {
      const inputs = foldRollupInputs(property.initializer, configDir);
      if (inputs.length > 0) rollupInputs = inputs;
      continue;
    }

    if (name === "publicDir") {
      const literal = stringLiteralValue(property.initializer);
      const resolved = literal === undefined ? undefined : path.resolve(configDir, literal);
      if (resolved && isDirectory(resolved)) publicDir = resolved;
      else ignored.add("publicDir");
      continue;
    }

    if (name === "resolve" && ts.isObjectLiteralExpression(property.initializer)) {
      for (const inner of property.initializer.properties) {
        if (!ts.isPropertyAssignment(inner)) continue;
        const innerName = literalPropertyName(inner);

        if (innerName === "alias") {
          if (!ts.isObjectLiteralExpression(inner.initializer)) {
            ignored.add("resolve.alias");
            continue;
          }
          for (const entry of inner.initializer.properties) {
            const find = ts.isPropertyAssignment(entry) ? literalPropertyName(entry) : undefined;
            const literalTarget = ts.isPropertyAssignment(entry)
              ? stringLiteralValue(entry.initializer)
              : undefined;
            // M93: a string literal wins when present; otherwise try the
            // resolve(...)/join(...) call-expression shape before giving up.
            const replacement =
              literalTarget !== undefined
                ? path.resolve(configDir, literalTarget)
                : ts.isPropertyAssignment(entry)
                  ? resolveCallExpressionPath(entry.initializer, configDir)
                  : undefined;
            if (!find || replacement === undefined) {
              ignored.add("resolve.alias");
              continue;
            }
            if (!fs.existsSync(replacement)) {
              ignored.add("resolve.alias");
              continue;
            }
            aliasEntries.push({ find, replacement: toPosix(replacement) });
          }
          continue;
        }

        if (
          innerName === "conditions" &&
          ts.isArrayLiteralExpression(inner.initializer) &&
          inner.initializer.elements.every((el) => ts.isStringLiteral(el))
        ) {
          conditions = inner.initializer.elements.map((el) => (el as ts.StringLiteral).text);
        }
      }
      continue;
    }

    if (name === "css" && ts.isObjectLiteralExpression(property.initializer)) {
      const preprocessor = property.initializer.properties.find(
        (inner) => literalPropertyName(inner) === "preprocessorOptions",
      );
      if (!preprocessor) continue;
      if (
        !ts.isPropertyAssignment(preprocessor) ||
        !ts.isObjectLiteralExpression(preprocessor.initializer)
      ) {
        ignored.add("css.preprocessorOptions");
        continue;
      }
      // M106 A3 (twenty-F2): twenty's own shape is
      // `additionalData: [`@use 'abstracts/functions' as *;`, ...].join(newline)`
      // with `loadPaths: [path.resolve(__dirname, 'src/styles')]` — a value a
      // text read can fold exactly, which is why the sass build failed with
      // `Undefined mixin` while the config that defines those mixins sat
      // unread. Anything that needs the config to run stays unhonored and says
      // so.
      for (const langProperty of preprocessor.initializer.properties) {
        if (!ts.isPropertyAssignment(langProperty)) {
          ignored.add("css.preprocessorOptions");
          continue;
        }
        const lang = literalPropertyName(langProperty);
        if (!lang || !ts.isObjectLiteralExpression(langProperty.initializer)) {
          ignored.add("css.preprocessorOptions");
          continue;
        }
        const langOptions: PreprocessorLangOptions = {};
        for (const option of langProperty.initializer.properties) {
          if (!ts.isPropertyAssignment(option)) {
            unfoldable.push(`css.preprocessorOptions.${lang}.<spread>`);
            continue;
          }
          const optionName = literalPropertyName(option);
          if (optionName === "additionalData") {
            const folded = foldStringExpression(option.initializer);
            if (folded === undefined) {
              // Review A5: named with its language and shape. The blanket
              // ignoredKeys entry (whose text asserts preprocessor globals are
              // not replicated at all) is added below only when nothing under
              // preprocessorOptions folded, since otherwise it is false.
              unfoldable.push(
                `css.preprocessorOptions.${lang}.additionalData (${expressionShape(option.initializer)})`,
              );
              continue;
            }
            langOptions.additionalData = folded;
            continue;
          }
          if (optionName === "loadPaths" || optionName === "includePaths") {
            const dirs = foldPathArray(option.initializer, configDir);
            if (dirs.length > 0) langOptions[optionName] = dirs;
            continue;
          }
          if (optionName) {
            unfoldable.push(`css.preprocessorOptions.${lang}.${optionName}`);
          }
        }
        if (Object.keys(langOptions).length > 0) {
          preprocessorOptions[lang] = { ...(preprocessorOptions[lang] ?? {}), ...langOptions };
        }
      }
      continue;
    }

    if (name === "plugins") {
      const elements = ts.isArrayLiteralExpression(property.initializer)
        ? property.initializer.elements
        : undefined;
      if (elements && elements.length === 0) continue;
      ignored.add("plugins");
      // M117 A3: what the note names, in the order the config declares them.
      if (elements) pluginNames = elements.map(declaredPluginName);
    }
  }

  // Review A5: the blanket key's own text asserts that preprocessor globals
  // are not replicated at all — true only when nothing under
  // preprocessorOptions folded. Otherwise each dropped option is named.
  if (unfoldable.length > 0 && Object.keys(preprocessorOptions).length === 0) {
    ignored.add("css.preprocessorOptions");
  }
  return {
    publicDir,
    ...(root !== undefined ? { root } : {}),
    ...(rollupInputs !== undefined ? { rollupInputs } : {}),
    aliasEntries,
    conditions,
    ignored,
    ...(pluginNames ? { pluginNames } : {}),
    ...(Object.keys(preprocessorOptions).length > 0 ? { preprocessorOptions } : {}),
    ...(unfoldable.length > 0 ? { unfoldablePreprocessor: unfoldable } : {}),
  };
}

function toAliasRegex(entry: { find: string; replacement: string }): { find: RegExp; replacement: string } {
  // Vite's object form matches a whole leading segment, the rule
  // @rollup/plugin-alias applies to a string `find`.
  return { find: new RegExp(`^${escapeRegex(entry.find)}(?=/|$)`), replacement: entry.replacement };
}

// M71: the config is read as text and parsed as a source file. It is never
// imported, so its plugins never load into this Vite and the invariant holds.
// M76: a second, additive read of workspaceRoot's own vite.config.* — skipped
// entirely when workspaceRoot === projectRoot, so a single-package project's
// output is byte-identical to before this milestone. Only resolve.alias and
// resolve.conditions are layered; publicDir and ignoredKeys stay member-only.
export function readViteConfigData(
  projectRoot: string,
  workspaceRoot: string = findWorkspaceRoot(projectRoot),
): ViteConfigData {
  const data: ViteConfigData = { aliases: [], ignoredKeys: [], conditions: [], warnings: [] };

  const configFile = findViteConfigFile(projectRoot);
  let parsed: ParsedViteConfig | undefined;
  if (configFile) {
    data.configFile = configFile;
    parsed = parseViteConfigFile(configFile);
    if (parsed) {
      if (parsed.publicDir) data.publicDir = parsed.publicDir;
      // M114 A3, A5: member-only, like publicDir — a workspace root's entry
      // is not this package's entry.
      if (parsed.root) data.root = parsed.root;
      if (parsed.rollupInputs) data.rollupInputs = parsed.rollupInputs;
      data.aliases = parsed.aliasEntries.map(toAliasRegex);
      data.conditions = parsed.conditions;
      data.ignoredKeys = IGNORED_KEY_ORDER.filter((key) => parsed!.ignored.has(key));
      if (parsed.pluginNames) data.pluginNames = parsed.pluginNames;
      // M106 A3: the foldable half travels to the server; the rest is named.
      if (parsed.preprocessorOptions) data.preprocessorOptions = parsed.preprocessorOptions;
      if (parsed.unfoldablePreprocessor) {
        data.warnings.push(
          VITE_CONFIG_PREPROCESSOR_OPTION_WARNING(
            path.basename(configFile),
            parsed.unfoldablePreprocessor,
          ),
        );
      }
    }
  }

  if (workspaceRoot !== projectRoot) {
    const rootConfigFile = findViteConfigFile(workspaceRoot);
    if (rootConfigFile && rootConfigFile !== configFile) {
      const rootParsed = parseViteConfigFile(rootConfigFile);
      if (rootParsed) {
        const forwardRootConfigFile = toPosix(rootConfigFile);
        const memberKeys = new Set((parsed?.aliasEntries ?? []).map((e) => e.find));
        for (const entry of rootParsed.aliasEntries) {
          if (memberKeys.has(entry.find)) continue;
          data.aliases.push(toAliasRegex(entry));
          data.warnings.push(
            VITE_CONFIG_WORKSPACE_ROOT_ALIAS_WARNING(
              entry.find,
              entry.replacement,
              forwardRootConfigFile,
              aliasedPackageMissingEntry(entry.find, projectRoot, entry.replacement),
            ),
          );
        }
        if (data.conditions.length === 0 && rootParsed.conditions.length > 0) {
          data.conditions = rootParsed.conditions;
          data.warnings.push(
            VITE_CONFIG_WORKSPACE_ROOT_CONDITIONS_WARNING(rootParsed.conditions, forwardRootConfigFile),
          );
        }
      }
    }
  }

  return data;
}
