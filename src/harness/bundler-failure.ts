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
import { findGitRoot } from "../shared/index.js";
import { diagnoseMissingShimExport } from "./shims.js";
import { resolveWorkspaceSourceEntry } from "./workspace-entries.js";

const RESOLVE_ENTRY_FAILURE = /Failed to resolve entry for package "([^"]+)"/;

// Vite/esbuild's own manifest fields to probe, in the order Node's own
// exports resolution would prefer them for a "." conditional export.
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

// M79 (3a). Vite's own "Failed to resolve entry for package" message blames a
// workspace-internal package's package.json fields when those fields are
// correct and the real problem is that the package was never built (its
// dist/ is gitignored and produced by a target this harness never runs).
// Returns undefined — falling through to the unchanged VITE_START_FAILED
// message — for anything that is not exactly this shape: a genuinely broken
// external dependency, or a workspace package whose entry does resolve.
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
  // A workspace-linked package's real path sits outside every node_modules
  // segment; an ordinary third-party dependency's real path always has one.
  // This is the discriminator between "internal, possibly-unbuilt package"
  // and "a genuinely broken external dependency".
  if (/[\\/]node_modules[\\/]/.test(real)) return undefined;
  const manifest = readProjectManifest(real);
  if (!manifest) return undefined;
  const entry = resolveManifestEntry(manifest);
  if (entry === undefined) return undefined;
  const entryPath = path.resolve(real, entry);
  if (fs.existsSync(entryPath)) return undefined;
  // M107 (gutenberg-F1): a build is not what this package needs when its own
  // source is on disk — scanExternalDeps aliases it, and the run reaches a
  // verdict instead of aborting.
  if (resolveWorkspaceSourceEntry(real, manifest) !== undefined) return undefined;
  return UNBUILT_WORKSPACE_PACKAGE_WARNING(pkg, path.relative(real, entryPath).replace(/\\/g, "/"));
}

// M94: a caught Vite/PostCSS/esbuild error's own .message frequently embeds
// raw stack frames -- shadcn-ui's PostCSS ENOENT (10 frames) and Vite import
// failure (8 frames) shapes both do -- referencing paths inside 120fps's own
// node_modules install. This is the fallback that makes "no raw bundler stack
// trace" hold even for a shape diagnoseBundlerFailure below does not
// specifically recognize.
// M92: conservative, not blanket -- only a frame whose own path sits inside
// 120fps's OWN installation is ever useless to a user and must go. A frame
// pointing into the target repository (its own node_modules, its own source)
// can be exactly what a user debugging their own component needs, and this
// function now runs on the page-error surface too (a post-boot render crash's
// stack is real application debugging information, not bundler noise), so
// removing every "at" line unconditionally is no longer correct.
function installRoot(): string {
  return path.resolve(import.meta.dirname ?? __dirname, "../..").replace(/\\/g, "/");
}

function stripBundlerStackFrames(message: string): string {
  const root = installRoot();
  const lines = message.split("\n");
  const kept = lines.filter((line) => {
    if (!/^\s*at\s/.test(line)) return true;
    return !line.replace(/\\/g, "/").includes(root);
  });
  // M92: this is now the universal fallback step of presentBundlerFailure,
  // reached by every throw on the page-error surface (analyze.ts's catch),
  // not only a recognized bundler shape. An ordinary message with no
  // 120fps-installation frame to strip must come back byte-identical --
  // reformatting (trim, blank-line collapse) an unrelated error's message is
  // its own kind of false statement about what the run printed.
  if (kept.length === lines.length) return message;
  return kept.join("\n").replace(/\n{2,}/g, "\n").trim();
}

// M92: the one diagnosis-and-disclosure pipeline every failure-arrival
// surface routes through, instead of each duplicating the chain:
//   1. buildAndServe's own synchronous boot catch (below) -- the dev server
//      itself never started.
//   2. The page-error channel (analyze.ts's harness-ready wait) -- the dev
//      server booted fine and a transform failed afterwards on a real
//      request (twenty's sass "Undefined mixin", shadcn-ui's postcss ENOENT
//      and Vite import-resolve, both arriving as page-error text with
//      120fps's own node_modules frames inside it).
//   3. The async unhandled-rejection surface (cli.ts) -- a fire-and-forget
//      Vite dependency-optimizer scan can still reject after buildAndServe's
//      own try/catch already exited successfully (ant-design's `./version`),
//      reaching neither of the above.
// A shape recognized on one surface is recognized on all three because they
// all call this same function; `buildWarnings` is optional because surface 3
// has no in-flight warnings array to offer diagnoseNuxtBuildModule's
// cross-reference.
export function presentBundlerFailure(
  message: string,
  projectRoot: string,
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

// M108 A5: names the layer that produces the specifier (a Vite plugin this
// harness never loads), and the package this repository declares for it. No
// build command: nothing on disk is missing, so no build produces it.
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

// M89 defect 3 (shadcn-ui, live proof): lets a caller detect this exact
// shape *before* presentBundlerFailure ever converts it into a fatal error,
// so a stylesheet that cannot be resolved/read can be dropped and the run
// continued unstyled instead -- the governing policy (M95 in
// specs/overview/02-milestones.md): skip unresolvable build artifacts and measure anyway wherever
// possible. Deliberately scoped to ENOENT alone: a stylesheet that resolves
// and then fails to *compile* (a real syntax/PostCSS/sass error in a file
// that genuinely exists, e.g. twenty's sass "Undefined mixin") does not
// match this pattern and must keep failing the run loudly -- this returns
// `undefined` for that shape by construction, not by a second check.
export function stylesheetReadFailureTarget(message: string): string | undefined {
  return POSTCSS_ENOENT_FAILURE.exec(message)?.[1];
}

// The disclosure a dropped stylesheet gets instead of a fatal error: names
// what was dropped, reuses BUNDLER_STYLESHEET_MISSING_ERROR's own
// well-written diagnosis of *why* (which stylesheet failed to read and its
// two remedies) as the body, and states the concrete consequence -- an
// unstyled measurement is a genuinely different one from a styled run.
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

// M94 (the shadcn-ui repro pair). Tried after diagnoseUnbuiltWorkspacePackage
// so the more specific "unbuilt workspace package" diagnosis still wins when
// both patterns could match the same message; returns undefined for any
// shape neither recognizes, so the caller's own stripBundlerStackFrames still
// runs as the universal fallback.
function diagnoseBundlerFailure(message: string, projectRoot: string): string | undefined {
  const importMatch = VITE_IMPORT_RESOLVE_FAILURE.exec(message);
  if (importMatch) {
    // M108 A5 (hoppscotch-F2): a virtual namespace has no file behind it and no
    // build that produces one, so the unbuilt-workspace clause is false here.
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

// M95 gap 1 (nuxt-ui-F2/F3): a Nuxt build-time virtual module ("#build/...")
// cannot resolve before `nuxi prepare` generates .nuxt/. Node's own package-
// imports resolver is what actually throws here (Vite delegates to it for a
// "#"-prefixed specifier), producing this exact shape rather than either of
// diagnoseBundlerFailure's two. Joined with a broken-tsconfig-extends-chain
// warning already collected in buildWarnings when one names the same
// generated directory ("nuxt-ui's tsconfig.json:2 extends ./.nuxt/tsconfig.json"
// and its "#build" virtual module are both consequences of the same absent
// .nuxt/ -- a user must not have to connect that themselves).
const NUXT_BUILD_MODULE_MISSING = /Missing "([^"]+)" specifier in "([^"]+)" package/;

// M92 (nuxt-ui, verified post-fix): `nuxi prepare` at the repo root can exit
// 0 and create .nuxt/ without producing THIS module's own generated
// templates -- nuxt-ui's root has no nuxt.config.ts of its own, so a
// root-level prepare never runs @nuxt/ui's module hooks and .nuxt/ui/ stays
// absent even though .nuxt/ itself now exists. Telling a user to run the
// exact command they already ran, with a byte-identical message, is false of
// the run that printed it a second time. `.nuxt/` existing on disk is what
// distinguishes "not yet prepared" from "prepared, wrong app context".
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

// M108 A2 (epic-stack-F1, primer-react-F1): the Nuxt mechanism is `#build`,
// `#imports` and `#app`, and only in a repository that declares nuxt. Every
// other package-imports/exports miss is Node's own resolver reporting a map
// that lacks a subpath, and that is what the message says.
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
  // M108 review: on a segment boundary. `#appsettings/x` is an ordinary
  // imports-map miss, and `nuxi prepare` is no remedy for it.
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

// M95 gap 2 (ant-design-F7): a relative import resolving to nothing, where
// the resolved target is gitignored, is a generated-file-not-yet-produced
// shape -- the repository's own build/codegen step produces it, a plain
// install does not -- not a typo or a genuine broken import to surface as a
// raw esbuild error. Path-aware (unlike cli.ts's gitignoreCoversFile, built
// for a single bare filename at the advisory-hint's own call site): reads
// git-root-relative path patterns.
const ESBUILD_COULD_NOT_RESOLVE = /([^\r\n]+?):(\d+):(\d+):\s*ERROR:\s*Could not resolve "([^"]+)"/;

const CODEGEN_SCRIPT_PRIORITY = ["codegen", "generate", "prepare", "postinstall", "build"];

// M105 (nuxt-ui-F2): `npm run build` in a repository that declares
// `packageManager: pnpm@11.22.0`, ships only a pnpm lockfile and calls
// `pnpm build` from its own scripts is a command that repository does not
// have. The field wins over the lockfile, and the member's own lockfile over
// the workspace root's.
type PackageManager = "npm" | "pnpm" | "yarn";

const LOCKFILE_MANAGER: Array<[string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

export function detectPackageManager(root: string): PackageManager {
  // Review A11: a declaration beats an artifact, at every level. A stray
  // package-lock.json inside a pnpm workspace member used to win over the
  // root's own `packageManager: pnpm@...` and print a command that repository
  // does not have — and it also makes `findWorkspaceRoot` stop at the member,
  // so the declaration walk goes up on its own, bounded by the repository.
  const levels: string[] = [];
  let cursor = path.resolve(root);
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

// M111 A5: a command the reader can paste. `<dir>` is the package's directory
// relative to the directory the run started in, posix-separated; the absolute
// path when no relative path exists (a different drive); nothing when the two
// are the same directory. `startDir` is a parameter rather than a read of
// `process.cwd()` so the message is a function of its inputs alone.
export function runDirectoryPrefix(root: string, startDir: string): string {
  const target = path.resolve(root);
  const from = path.resolve(startDir);
  if (target === from) return "";
  const relative = path.relative(from, target);
  const dir = relative === "" || path.isAbsolute(relative) ? target : relative.replace(/\\/g, "/");
  // A directory whose name contains a space is not pasteable unquoted.
  return `cd ${/\s/.test(dir) ? `"${dir}"` : dir} && `;
}

// yarn runs a script by bare name; npm and pnpm need `run` for anything
// outside their own lifecycle names.
export function packageManagerRunCommand(root: string, script: string, startDir?: string): string {
  const manager = detectPackageManager(root);
  const run = manager === "yarn" ? `yarn ${script}` : `${manager} run ${script}`;
  return startDir === undefined ? run : runDirectoryPrefix(root, startDir) + run;
}

// M111 A5: the one place a remedy turns a package's script into a command. A
// script the manifest does not declare has no command, and a script *body* is
// never printed: it belongs to another package's build, not to the reader's
// shell.
export function packageScriptCommand(
  root: string,
  script: string,
  startDir?: string,
): string | undefined {
  const scripts = readProjectManifest(root)?.scripts as Record<string, unknown> | undefined;
  if (typeof scripts?.[script] !== "string") return undefined;
  return packageManagerRunCommand(root, script, startDir);
}

// M105 (ant-design-F1): the script *name* list alone chose `prepare`
// (`is-ci || husky && dumi setup`) for a missing `components/version/version.ts`
// that `version` (`tsx scripts/generate-version.ts`) writes. A script's command
// text is the evidence: it either names the missing path or names a generator
// for it.
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
    const posix = missingRelativePath.replace(/\\/g, "/");
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

// Exact match, or a single "*" wildcard prefix/suffix -- the same rule
// cli.ts's gitignoreCoversFile applies, extended to a full relative path
// instead of a bare filename, and to a bare-filename pattern (no "/") also
// matching at any depth, the way git itself treats one.
function gitignoreCoversPath(gitignoreContent: string, relativePath: string): boolean {
  const posixPath = relativePath.replace(/\\/g, "/");
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
  // Every candidate already existing means this is not "resolves to nothing"
  // at all; some other cause produced the esbuild error.
  if (candidates.every((c) => fs.existsSync(c))) return undefined;
  const gitRoot = findGitRoot(importerDir);
  if (!gitRoot) return undefined;
  let gitignoreContent: string;
  try {
    gitignoreContent = fs.readFileSync(path.join(gitRoot, ".gitignore"), "utf-8");
  } catch {
    return undefined;
  }
  const relativeToGitRoot = path.relative(gitRoot, candidateBase).replace(/\\/g, "/");
  const relativeCandidates = [
    relativeToGitRoot,
    ...SOURCE_EXTENSIONS.map((ext) => relativeToGitRoot + ext),
  ];
  const matchedRelative = relativeCandidates.find((rel) => gitignoreCoversPath(gitignoreContent, rel));
  if (matchedRelative === undefined) return undefined;
  const matchedAbsolute = path.resolve(gitRoot, matchedRelative);
  const relativeToProject = path.relative(projectRoot, matchedAbsolute).replace(/\\/g, "/");
  return GITIGNORED_GENERATED_FILE_ERROR(
    relativeToProject,
    // M105 (ant-design-F1): the missing file is the evidence for which script
    // produces it, so it is passed rather than left to a name list.
    findLikelyGenerateCommand(projectRoot, relativeToProject, process.cwd()),
  );
}
