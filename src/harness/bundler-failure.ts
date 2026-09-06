import fs from "node:fs";
import path from "node:path";
import {
  CSS_PREPROCESSOR_PACKAGES,
  declaredTransformOwner,
  findWorkspaceRoot,
  installedPackageDir,
  isPackageDeclared,
  packageManagerAddCommand,
  packageManagerInstallCommand,
  packageManagerRunCommand,
  readProjectManifest,
  recognizeVirtualNamespace,
  SOURCE_EXTENSIONS,
} from "../project/index.js";
import { findGitRoot, toPosix } from "../shared/index.js";
import { diagnoseMissingShimExport } from "./shims.js";
import { resolveWorkspaceSourceEntry } from "./workspace-entries.js";

const RESOLVE_ENTRY_FAILURE = /Failed to resolve entry for package "([^"]+)"/;

// In the order Node's own exports resolution prefers them for a "." conditional export.
export function resolveManifestEntry(manifest: Record<string, unknown>): string | undefined {
  const exportsField = manifest.exports;
  if (typeof exportsField === "string") return exportsField;
  if (exportsField && typeof exportsField === "object" && !Array.isArray(exportsField)) {
    const dot = (exportsField as Record<string, unknown>)["."];
    if (typeof dot === "string") return dot;
    if (dot && typeof dot === "object" && !Array.isArray(dot)) {
      for (const condition of ["default", "import", "require"]) {
        const value = (dot as Record<string, unknown>)[condition];
        if (typeof value === "string") return value;
      }
    }
  }
  if (typeof manifest.module === "string") return manifest.module;
  if (typeof manifest.main === "string") return manifest.main;
  return undefined;
}

export const UNBUILT_WORKSPACE_PACKAGE_WARNING = (pkg: string, entryRelative: string): string =>
  `${pkg} is a workspace package whose package.json points at ${entryRelative}, which does not ` +
  "exist on disk: it needs a build step (that build output was never produced), not a " +
  "package.json fix. Run this workspace's build for that package, then measure again.";

// Vite blames the package.json fields when the real problem is that nothing built the dist/.
export function diagnoseUnbuiltWorkspacePackage(
  viteMessage: string,
  projectRoot: string,
): string | undefined {
  const match = RESOLVE_ENTRY_FAILURE.exec(viteMessage);
  if (!match) return undefined;
  const pkg = match[1];
  const pkgDir = installedPackageDir(pkg, projectRoot);
  if (!pkgDir) return undefined;
  let real: string;
  try {
    real = fs.realpathSync(pkgDir);
  } catch {
    return undefined;
  }
  // A workspace-linked package's real path has no node_modules segment; an external one does.
  if (/[\\/]node_modules[\\/]/.test(real)) return undefined;
  const manifest = readProjectManifest(real);
  if (!manifest) return undefined;
  const entry = resolveManifestEntry(manifest);
  if (entry === undefined) return undefined;
  const entryPath = path.resolve(real, entry);
  if (fs.existsSync(entryPath)) return undefined;
  // Source on disk means scanExternalDeps aliases it, and the run reaches a verdict.
  if (resolveWorkspaceSourceEntry(real, manifest) !== undefined) return undefined;
  return UNBUILT_WORKSPACE_PACKAGE_WARNING(pkg, toPosix(path.relative(real, entryPath)));
}

function installRoot(): string {
  return toPosix(path.resolve(import.meta.dirname ?? __dirname, "../.."));
}

// Only a frame inside 120fps's own installation is useless; a target-repo frame is evidence.
function stripBundlerStackFrames(message: string): string {
  const root = installRoot();
  const lines = message.split("\n");
  const kept = lines.filter((line) => {
    if (!/^\s*at\s/.test(line)) return true;
    return !line.replace(/\\/g, "/").includes(root);
  });
  // An unrelated message with no frame to strip must come back byte-identical.
  if (kept.length === lines.length) return message;
  return kept.join("\n").replace(/\n{2,}/g, "\n").trim();
}

// The harness's own two lead sentences; a bundler pattern below one is evidence, not the failure.
const HARNESS_READINESS_LEAD =
  /(?:did not become ready within timeout|failed before it became ready)/;

function isHarnessReadinessReport(message: string): boolean {
  return HARNESS_READINESS_LEAD.test(message.split("\n", 1)[0]);
}

// One diagnosis pipeline for every arrival surface, so a shape recognized on one is on all.
export function presentBundlerFailure(
  message: string,
  projectRoot: string,
  // Optional: the unhandled-rejection surface has no in-flight warnings array to offer.
  buildWarnings: readonly string[] = [],
): string {
  const diagnosis =
    diagnoseUnbuiltWorkspacePackage(message, projectRoot) ??
    diagnoseMissingShimExport(message) ??
    diagnoseGitignoredGeneratedFile(message, projectRoot) ??
    diagnoseNuxtBuildModule(message, buildWarnings, projectRoot) ??
    diagnosePreprocessorMissing(message, projectRoot) ??
    diagnoseStalePreprocessor(message, projectRoot) ??
    diagnoseBundlerFailure(message, projectRoot);
  // The readiness report is the run's own account of the wait; a diagnosis explains it, never
  // replaces it. One of the two, never both: a second explanation of one failure reads as a guess.
  if (isHarnessReadinessReport(message)) {
    const explanation = diagnosis ?? diagnoseMuteReadinessTimeout(message, buildWarnings);
    const report = stripBundlerStackFrames(message);
    return explanation ? `${report}\n${explanation}` : report;
  }
  return diagnosis ?? stripBundlerStackFrames(message);
}

// An empty capture is the whole point: nothing threw, so nothing named itself.
const READY_TIMEOUT_WITHOUT_ERRORS = /did not become ready within timeout\. No page errors were captured\./;
// The run's own stylesheet decision line; "none" and "dropped" mean the entry imports no sheet.
const INJECTED_STYLESHEET = /^Stylesheets: (?!none\b|dropped\b)(.+?)(?: \(|$)/m;

export function READINESS_STYLESHEET_SUSPECT(files: string): string {
  return (
    `The first import of the generated harness entry is the stylesheet this run injected: ${files}. ` +
    "A stylesheet that compiles slowly, or not at all, holds that entry module without raising a " +
    "page error, which is the shape of this failure. Re-run with --no-css to take it out of the " +
    "graph, or with --css <file> to name a smaller one: if the harness becomes ready then, that " +
    "stylesheet is what held it."
  );
}

// Nothing to blame, and saying so keeps the next reader from re-testing a sheet already gone.
export const READINESS_STYLESHEET_CLEARED =
  "No stylesheet is in the generated harness entry: every sheet this run discovered failed the " +
  "compile probe and was dropped before the page opened, so none of them held that entry module. " +
  "What held it is elsewhere in this component's own graph.";

// Both probe warnings lead with the sheet they dropped; the entry the page got is what is left.
const PROBE_DROPPED_STYLESHEET = /^(.+?) did not compile(?: within | \()/;

function diagnoseMuteReadinessTimeout(
  message: string,
  buildWarnings: readonly string[],
): string | undefined {
  if (!READY_TIMEOUT_WITHOUT_ERRORS.test(message)) return undefined;
  const decided = buildWarnings
    .map((warning) => INJECTED_STYLESHEET.exec(warning)?.[1])
    .find((match): match is string => match !== undefined);
  if (!decided) return undefined;
  const dropped = new Set(
    buildWarnings
      .map((warning) => PROBE_DROPPED_STYLESHEET.exec(warning)?.[1])
      .filter((label): label is string => label !== undefined),
  );
  // The compile probe runs before the page opens; only a sheet that survived it is in the entry.
  const survivors = decided.split(", ").filter((file) => !dropped.has(file));
  return survivors.length > 0
    ? READINESS_STYLESHEET_SUSPECT(survivors.join(", "))
    : READINESS_STYLESHEET_CLEARED;
}

const VITE_PREPROCESSOR_MISSING = /Preprocessor dependency "([^"]+)" not found/;
// The dev server's own URL for the file it could not transform, the only importer in the message.
const HARNESS_REQUEST_500 = /response 500: GET (\S+)/;

// Vite reports only the first package it tried; sass has a second name it tries after it.
function preprocessorFamily(lang: string): string[] {
  const family = Object.values(CSS_PREPROCESSOR_PACKAGES).find((pkgs) => pkgs.includes(lang));
  // sass-embedded is reported, sass is tried second: name them in the order Vite tries them.
  return family && family.length > 1 ? [lang, ...family.filter((pkg) => pkg !== lang)] : [lang];
}

// `http://host/@fs/E:/a/b.vue?vue&type=style&lang.scss` is one file, named once.
function requestedFile(url: string): string {
  const withoutQuery = url.split("?")[0];
  const withoutOrigin = withoutQuery.replace(/^https?:\/\/[^/]+\//, "");
  return withoutOrigin.replace(/^@fs\//, "");
}

export function PREPROCESSOR_UNAVAILABLE_ERROR(
  file: string,
  packages: string[],
  installCommand: string,
): string {
  const last = packages[packages.length - 1];
  // Vite tries them in this order and reports only the first, so the message keeps the order.
  const tried = packages.length > 1 ? `${packages.slice(0, -1).join(", ")} and then ${last}` : last;
  return (
    `${file} needs a CSS preprocessor the dev server could not load: Vite looked for ${tried}, ` +
    "first up the node_modules chain of the measured package and then in its own installed copy, " +
    `and found none of them. Install it where the measured package resolves it: ${installCommand}`
  );
}

function diagnosePreprocessorMissing(message: string, projectRoot: string): string | undefined {
  const match = VITE_PREPROCESSOR_MISSING.exec(message);
  if (!match) return undefined;
  const packages = preprocessorFamily(match[1]);
  const url = HARNESS_REQUEST_500.exec(message)?.[1];
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  // Declared but absent needs an install, not another dependency line.
  const declared = packages.find((pkg) => isPackageDeclared(pkg, projectRoot, workspaceRoot));
  const command = declared
    ? packageManagerInstallCommand(projectRoot, process.cwd())
    : packageManagerAddCommand(projectRoot, packages[packages.length - 1], process.cwd());
  return PREPROCESSOR_UNAVAILABLE_ERROR(
    url ? requestedFile(url) : "a stylesheet in this component's graph",
    packages,
    command,
  );
}

// Vite calls a preprocessor's async compile API; a version pinned below it has no such method.
const PREPROCESSOR_METHOD_MISSING = /\[(sass|less|stylus)\][^\n]*?\b([A-Za-z_$][\w$]*) is not a function/;

// The Dart Sass release that first provided the modern compileStringAsync API Vite calls.
const SASS_MODERN_API_MINIMUM = "1.45.0";

// Vite labels both Dart Sass packages `[sass]`, and tries the embedded one first.
const PREPROCESSOR_PACKAGES_BY_LABEL: Record<string, string[]> = {
  sass: ["sass-embedded", "sass"],
  less: ["less"],
  stylus: ["stylus"],
};

export function STALE_PREPROCESSOR_ERROR(
  file: string,
  pkg: string,
  version: string | undefined,
  method: string,
  minimum: string | undefined,
  upgradeCommand: string,
): string {
  const installed = version ? `${pkg} ${version} is installed and` : `the installed ${pkg}`;
  const wanted = minimum ? `${pkg} ${minimum} or newer` : `a ${pkg} that provides it`;
  return (
    `${file} needs a CSS preprocessor this project pins below what the dev server calls: Vite asks ` +
    `for ${method}(), and ${installed} does not define it. Install ${wanted} where the measured ` +
    `package resolves it: ${upgradeCommand}. Or pass --no-css to measure without the stylesheet.`
  );
}

// The version is read, never guessed: an unreadable manifest leaves the API as the whole finding.
function diagnoseStalePreprocessor(message: string, projectRoot: string): string | undefined {
  const match = PREPROCESSOR_METHOD_MISSING.exec(message);
  if (!match) return undefined;
  const [, label, method] = match;
  const candidates = PREPROCESSOR_PACKAGES_BY_LABEL[label] ?? [label];
  const installed = candidates
    .map((pkg) => ({ pkg, dir: installedPackageDir(pkg, projectRoot) }))
    .find((entry): entry is { pkg: string; dir: string } => entry.dir !== undefined);
  const pkg = installed?.pkg ?? candidates[candidates.length - 1];
  const version = installed ? readProjectManifest(installed.dir)?.version : undefined;
  const url = HARNESS_REQUEST_500.exec(message)?.[1];
  return STALE_PREPROCESSOR_ERROR(
    url ? requestedFile(url) : "a stylesheet in this component's graph",
    pkg,
    typeof version === "string" ? version : undefined,
    method,
    installed && pkg === "sass" ? SASS_MODERN_API_MINIMUM : undefined,
    packageManagerAddCommand(projectRoot, `${pkg}@latest`, process.cwd()),
  );
}

const VITE_IMPORT_RESOLVE_FAILURE = /Failed to resolve import "([^"]+)" from "([^"]+)"/;
const POSTCSS_ENOENT_FAILURE = /\[postcss\] ENOENT: no such file or directory, open '([^']+)'/;

export function BUNDLER_IMPORT_UNRESOLVED_ERROR(target: string, importer: string): string {
  return (
    `${importer} imports "${target}", which the dev server could not resolve to a loadable file. ` +
    "Check that the target exists; if it lives in an unbuilt workspace package, run that package's " +
    "own build first."
  );
}

// No build command: nothing on disk is missing, so no build produces it.
export function VIRTUAL_NAMESPACE_IMPORT_ERROR(
  target: string,
  importer: string,
  namespace: string,
  producer: string | undefined,
): string {
  const base =
    `${importer} imports "${target}", a module in the \`${namespace}\` virtual namespace: a Vite ` +
    "plugin generates it at request time, and 120fps never reads your vite.config, so nothing " +
    "answers for it here.";
  return producer
    ? `${base} This repository declares ${producer}, the plugin that owns that namespace; measure ` +
        "a component that does not import from it, or stub the import."
    : `${base} Measure a component that does not import from it, or stub the import.`;
}

export function BUNDLER_STYLESHEET_MISSING_ERROR(target: string): string {
  return (
    `${target} could not be read: the stylesheet does not exist on disk, most likely because it is ` +
    "generated by a build this harness never runs. Run that package's build, or pass --no-css to " +
    "skip stylesheet injection."
  );
}

// ENOENT alone: a stylesheet that exists and fails to compile must keep failing the run.
export function stylesheetReadFailureTarget(message: string): string | undefined {
  return POSTCSS_ENOENT_FAILURE.exec(message)?.[1];
}

// An unstyled measurement is a genuinely different one, so the consequence is stated.
export function CSS_UNREADABLE_DROPPED_WARNING(
  missingTarget: string,
  droppedFiles: string[],
): string {
  const named =
    droppedFiles.length === 1
      ? droppedFiles[0]
      : `all ${droppedFiles.length} discovered stylesheets (${droppedFiles.join(", ")})`;
  return (
    `dropped ${named} and measured unstyled: ${BUNDLER_STYLESHEET_MISSING_ERROR(missingTarget)} ` +
    "Layout-dependent metrics (mount size, reflow-sensitive timings) may differ from a fully-styled " +
    "production render; pass --css to name a stylesheet that resolves once the build that generates " +
    "this one has run."
  );
}

// Tried after diagnoseUnbuiltWorkspacePackage, so the more specific diagnosis still wins.
function diagnoseBundlerFailure(message: string, projectRoot: string): string | undefined {
  const importMatch = VITE_IMPORT_RESOLVE_FAILURE.exec(message);
  if (importMatch) {
    // A virtual namespace has no file behind it, so the unbuilt-workspace clause is false.
    const virtual = recognizeVirtualNamespace(importMatch[1]);
    if (virtual) {
      return VIRTUAL_NAMESPACE_IMPORT_ERROR(
        importMatch[1],
        importMatch[2],
        virtual.namespace,
        declaredTransformOwner("virtual-module", importMatch[1], projectRoot),
      );
    }
    return BUNDLER_IMPORT_UNRESOLVED_ERROR(importMatch[1], importMatch[2]);
  }
  const cssMatch = POSTCSS_ENOENT_FAILURE.exec(message);
  if (cssMatch) return BUNDLER_STYLESHEET_MISSING_ERROR(cssMatch[1]);
  return undefined;
}

// Node's own package-imports resolver throws this shape, not either of the two above.
const NUXT_BUILD_MODULE_MISSING = /Missing "([^"]+)" specifier in "([^"]+)" package/;

// `.nuxt/` on disk distinguishes "not yet prepared" from "prepared, wrong app context".
export function NUXT_BUILD_MODULE_MISSING_ERROR(
  specifier: string,
  pkg: string,
  extendsHint: boolean,
  nuxtDirExists: boolean,
  repoScriptCommand: string | undefined,
): string {
  if (nuxtDirExists) {
    const remedy = repoScriptCommand
      ? ` Try this repository's own \`${repoScriptCommand}\` script, which builds this kind of ` +
        "module template."
      : " Check this repository's package.json scripts for the command that builds this module's " +
        "own generated templates.";
    return (
      `${pkg} imports from "${specifier}", a Nuxt build-time virtual module. .nuxt/ already exists, ` +
      "but this module's own generated templates inside it are still missing: `nuxi prepare` alone " +
      `did not produce them (a root-level prepare does not always run every module's own hooks).` +
      remedy
    );
  }
  const base =
    `${pkg} imports from "${specifier}", a Nuxt build-time virtual module that does not exist ` +
    "until `nuxi prepare` generates the .nuxt/ directory. Run `nuxi prepare` in this project, " +
    "then measure again.";
  return extendsHint
    ? `${base} (The same .nuxt/ directory this project's tsconfig.json extends from and could ` +
        "not read, reported above.)"
    : base;
}

// Only in a repository that declares nuxt; every other miss is an ordinary imports-map miss.
const NUXT_VIRTUAL_PREFIXES = ["#build", "#imports", "#app"];

export function MISSING_PACKAGE_SUBPATH_ERROR(
  specifier: string,
  pkg: string,
  importer: string | undefined,
): string {
  const from = importer ? `, imported by ${importer}` : "";
  const map = specifier.startsWith("#") ? "imports" : "exports";
  return (
    `${pkg} does not declare "${specifier}" in its package.json \`${map}\` map${from}, so Node's ` +
    `own resolver refused it. Declare that subpath in ${pkg}'s \`${map}\` map, or import a path ` +
    "the map already exposes."
  );
}

function diagnoseNuxtBuildModule(
  message: string,
  buildWarnings: readonly string[],
  projectRoot: string,
): string | undefined {
  const match = NUXT_BUILD_MODULE_MISSING.exec(message);
  if (!match) return undefined;
  // On a segment boundary: `#appsettings/x` is an ordinary imports-map miss.
  const isNuxtVirtual = NUXT_VIRTUAL_PREFIXES.some(
    (prefix) => match[1] === prefix || match[1].startsWith(prefix + "/"),
  );
  if (!isNuxtVirtual || !isPackageDeclared("nuxt", projectRoot, findWorkspaceRoot(projectRoot))) {
    return MISSING_PACKAGE_SUBPATH_ERROR(match[1], match[2], VITE_IMPORT_RESOLVE_FAILURE.exec(message)?.[2]);
  }
  const extendsHint = buildWarnings.some((w) => w.includes(".nuxt"));
  const nuxtDirExists = fs.existsSync(path.join(projectRoot, ".nuxt"));
  return NUXT_BUILD_MODULE_MISSING_ERROR(
    match[1],
    match[2],
    extendsHint,
    nuxtDirExists,
    nuxtDirExists ? findLikelyGenerateCommand(projectRoot, undefined, process.cwd()) : undefined,
  );
}

// A relative import resolving to a gitignored target is a generated file, not a typo.
const ESBUILD_COULD_NOT_RESOLVE = /([^\r\n]+?):(\d+):(\d+):\s*ERROR:\s*Could not resolve "([^"]+)"/;

const CODEGEN_SCRIPT_PRIORITY = ["codegen", "generate", "prepare", "postinstall", "build"];

// Re-exported from their own module: which package manager a repository uses is a project fact.
export {
  detectPackageManager,
  packageManagerAddCommand,
  packageManagerInstallCommand,
  packageManagerRunCommand,
  runDirectoryPrefix,
  type PackageManager,
} from "../project/index.js";

// A script body is never printed: it belongs to another package's build, not to the shell.
export function packageScriptCommand(
  root: string,
  script: string,
  startDir?: string,
): string | undefined {
  const scripts = readProjectManifest(root)?.scripts as Record<string, unknown> | undefined;
  if (typeof scripts?.[script] !== "string") return undefined;
  return packageManagerRunCommand(root, script, startDir);
}

// A script's command text is the evidence: the name list alone picked the wrong script.
const GENERATOR_TOKEN = /(generate|codegen|gen)/i;

export function findLikelyGenerateCommand(
  root: string,
  missingRelativePath?: string,
  startDir?: string,
): string | undefined {
  const manifest = readProjectManifest(root);
  const scripts = manifest?.scripts as Record<string, unknown> | undefined;
  if (!scripts) return undefined;
  const commands = Object.entries(scripts).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );

  if (missingRelativePath) {
    const posix = toPosix(missingRelativePath);
    const named = commands.find(([, command]) => command.replace(/\\/g, "/").includes(posix));
    if (named) return packageManagerRunCommand(root, named[0], startDir);

    const stem = path.basename(posix, path.extname(posix)).toLowerCase();
    if (stem) {
      const generates = commands.find(([, command]) => {
        const lower = command.toLowerCase();
        return lower.includes(stem) && GENERATOR_TOKEN.test(lower);
      });
      if (generates) return packageManagerRunCommand(root, generates[0], startDir);
    }
  }

  for (const name of CODEGEN_SCRIPT_PRIORITY) {
    if (typeof scripts[name] === "string") return packageManagerRunCommand(root, name, startDir);
  }
  return undefined;
}

// Exact match, or one "*" wildcard; a bare-filename pattern matches at any depth, as git does.
function gitignoreCoversPath(gitignoreContent: string, relativePath: string): boolean {
  const posixPath = toPosix(relativePath);
  const base = posixPath.slice(posixPath.lastIndexOf("/") + 1);
  for (const rawLine of gitignoreContent.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const pattern = line.replace(/^\//, "").replace(/\/$/, "");
    if (pattern === posixPath) return true;
    if (!pattern.includes("/") && pattern === base) return true;
    const star = pattern.indexOf("*");
    if (star === -1 || pattern.indexOf("*", star + 1) !== -1) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (
      posixPath.length >= prefix.length + suffix.length &&
      posixPath.startsWith(prefix) &&
      posixPath.endsWith(suffix)
    ) {
      return true;
    }
  }
  return false;
}

export function GITIGNORED_GENERATED_FILE_ERROR(
  relativePath: string,
  generateCommand: string | undefined,
): string {
  return (
    `${relativePath} does not exist and is gitignored: it is generated by this repository's own ` +
    "build/codegen step, not something a plain install produces." +
    (generateCommand
      ? ` Run \`${generateCommand}\` in this project, then measure again.`
      : " Check this repository's package.json scripts or README for the command that generates " +
        "it, then measure again.")
  );
}

function diagnoseGitignoredGeneratedFile(message: string, projectRoot: string): string | undefined {
  const match = ESBUILD_COULD_NOT_RESOLVE.exec(message);
  if (!match) return undefined;
  const [, importerRaw, , , specifier] = match;
  if (!specifier.startsWith(".")) return undefined;
  const importerAbs = path.resolve(projectRoot, importerRaw.trim());
  const importerDir = path.dirname(importerAbs);
  const candidateBase = path.resolve(importerDir, specifier);
  const candidates = [candidateBase, ...SOURCE_EXTENSIONS.map((ext) => candidateBase + ext)];
  // Every candidate existing means this is not "resolves to nothing"; another cause produced it.
  if (candidates.every((c) => fs.existsSync(c))) return undefined;
  const gitRoot = findGitRoot(importerDir);
  if (!gitRoot) return undefined;
  let gitignoreContent: string;
  try {
    gitignoreContent = fs.readFileSync(path.join(gitRoot, ".gitignore"), "utf-8");
  } catch {
    return undefined;
  }
  const relativeToGitRoot = toPosix(path.relative(gitRoot, candidateBase));
  const relativeCandidates = [
    relativeToGitRoot,
    ...SOURCE_EXTENSIONS.map((ext) => relativeToGitRoot + ext),
  ];
  const matchedRelative = relativeCandidates.find((rel) => gitignoreCoversPath(gitignoreContent, rel));
  if (matchedRelative === undefined) return undefined;
  const matchedAbsolute = path.resolve(gitRoot, matchedRelative);
  const relativeToProject = toPosix(path.relative(projectRoot, matchedAbsolute));
  return GITIGNORED_GENERATED_FILE_ERROR(
    relativeToProject,
    // The missing file is the evidence for which script produces it, so it is passed.
    findLikelyGenerateCommand(projectRoot, relativeToProject, process.cwd()),
  );
}
