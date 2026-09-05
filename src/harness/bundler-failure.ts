import fs from "node:fs";
import path from "node:path";
import {
  declaredTransformOwner,
  findWorkspaceRoot,
  installedPackageDir,
  isPackageDeclared,
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

// One diagnosis pipeline for every arrival surface, so a shape recognized on one is on all.
export function presentBundlerFailure(
  message: string,
  projectRoot: string,
  // Optional: the unhandled-rejection surface has no in-flight warnings array to offer.
  buildWarnings: readonly string[] = [],
): string {
  return (
    diagnoseUnbuiltWorkspacePackage(message, projectRoot) ??
    diagnoseMissingShimExport(message) ??
    diagnoseGitignoredGeneratedFile(message, projectRoot) ??
    diagnoseNuxtBuildModule(message, buildWarnings, projectRoot) ??
    diagnoseBundlerFailure(message, projectRoot) ??
    stripBundlerStackFrames(message)
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

// The packageManager field wins over the lockfile, and the member's lockfile over the root's.
type PackageManager = "npm" | "pnpm" | "yarn";

const LOCKFILE_MANAGER: Array<[string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

export function detectPackageManager(root: string): PackageManager {
  // A declaration beats an artifact: a stray package-lock.json in a pnpm member must not win.
  const levels: string[] = [];
  let cursor = path.resolve(root);
  // findWorkspaceRoot stops at a member with a stray lockfile, so this walk goes up to .git.
  while (true) {
    levels.push(cursor);
    if (fs.existsSync(path.join(cursor, ".git"))) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const workspaceRoot = findWorkspaceRoot(root);
  if (!levels.includes(workspaceRoot)) levels.push(workspaceRoot);
  for (const level of levels) {
    const declared = readProjectManifest(level)?.packageManager;
    if (typeof declared !== "string") continue;
    const name = declared.split("@")[0].trim();
    if (name === "pnpm" || name === "yarn" || name === "npm") return name;
  }
  for (const level of [root, workspaceRoot]) {
    for (const [file, manager] of LOCKFILE_MANAGER) {
      if (fs.existsSync(path.join(level, file))) return manager;
    }
  }
  return "npm";
}

// startDir is a parameter, not a read of `process.cwd()`, so the message is a function of it.
export function runDirectoryPrefix(root: string, startDir: string): string {
  const target = path.resolve(root);
  const from = path.resolve(startDir);
  if (target === from) return "";
  const relative = path.relative(from, target);
  const dir = relative === "" || path.isAbsolute(relative) ? target : toPosix(relative);
  // A directory whose name contains a space is not pasteable unquoted.
  return `cd ${/\s/.test(dir) ? `"${dir}"` : dir} && `;
}

// yarn runs a script by bare name; npm and pnpm need `run` outside their lifecycle names.
export function packageManagerRunCommand(root: string, script: string, startDir?: string): string {
  const manager = detectPackageManager(root);
  const run = manager === "yarn" ? `yarn ${script}` : `${manager} run ${script}`;
  return startDir === undefined ? run : runDirectoryPrefix(root, startDir) + run;
}

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
