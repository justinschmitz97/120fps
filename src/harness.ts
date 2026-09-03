import { createServer, searchForWorkspaceRoot, transformWithEsbuild, type ViteDevServer } from "vite";
import ts from "typescript";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { CompositionTree, CompositionNode, ExportInfo } from "./composition.js";
import { scanExports, normalizeComponentName, selectMeasuredExport } from "./prop-gen.js";
import {
  isVueFile,
  loadVueCompiler,
  templateHasUnconditionalRoot,
  type VueSfcCompiler,
} from "./vue-sfc.js";
import {
  detectPnP,
  findCompilerConfig,
  findProjectRoot,
  resolveGoverningTsconfig,
  TSCONFIG_EXTENDS_BROKEN_WARNING,
  TSCONFIG_REFERENCES_MARKER,
  findWorkspaceRoot,
  installedPackageDir,
  isPackageAvailable,
  isPackageDeclared,
  readProjectManifest,
  workspaceLevels,
} from "./project-model.js";
import {
  declaredTransformOwner,
  detectMissingInstall,
  hardRemedyFor,
  recognizeVirtualNamespace,
} from "./preflight.js";
// Import cycle (harness -> react-profiler -> measure -> harness), safe by
// construction: every cross-module binding on all three edges is read inside a
// function body, never during module evaluation, so no partially-initialized
// namespace is ever observed.
import { detectFramework } from "./react-profiler.js";

export { findProjectRoot };

// M57. The measured file's own extension decides how it is mounted: a `.vue`
// SFC cannot be rendered by React and a `.tsx` cannot be rendered by Vue, so
// this is stronger evidence than anything in package.json.
export type Renderer = "react" | "vue";

export function rendererFor(filePath: string): Renderer {
  return isVueFile(filePath) ? "vue" : "react";
}

// An SFC's component is its default export and has no exported name, so the
// entry's import binding is derived from the filename. Vue's own convention is
// kebab-case files, which is not an identifier: `my-button.vue` must not
// generate `import My-button`.
export function vueComponentName(filePath: string): string {
  const stem = path.basename(filePath, path.extname(filePath));
  const name = stem
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return /^[A-Za-z_$]/.test(name) ? name : `Component${name}`;
}

export interface ShimEntry {
  module: string;
  shimFile: string;
}

export const SHIM_MODULES: ShimEntry[] = [
  { module: "next/image", shimFile: "next-image.js" },
  { module: "next/dynamic", shimFile: "next-dynamic.js" },
  { module: "next/link", shimFile: "next-link.js" },
  { module: "next/navigation", shimFile: "next-navigation.js" },
  { module: "next/headers", shimFile: "next-headers.js" },
  { module: "next/script", shimFile: "next-script.js" },
  { module: "next/head", shimFile: "next-head.js" },
  { module: "next/router", shimFile: "next-router.js" },
  { module: "next/font/local", shimFile: "next-font-local.js" },
  { module: "next-video/player", shimFile: "next-video-player.js" },
];

// M73: everything else under `next/` resolves from the project's own Next
// install, where a module written for the server or for the compiler plugin can
// fail to load in a plain browser. Named rather than blocked: it may work.
// `next/font/google` is here permanently, not by omission: each font family is
// a separate named export, the set is unbounded, and a browser rejects a named
// import its target module does not provide, so no static shim can answer it.
export function unshimmedNextModules(specifiers: Iterable<string>): string[] {
  const shimmed = new Set(SHIM_MODULES.map((entry) => entry.module));
  const unshimmed = new Set<string>();
  for (const spec of specifiers) {
    if (spec.startsWith("next/") && !shimmed.has(spec)) unshimmed.add(spec);
  }
  return [...unshimmed].sort();
}

export function UNSUPPORTED_NEXT_MODULE_WARNING(modules: string[]): string {
  return (
    `${modules.join(", ")} ${modules.length === 1 ? "is" : "are"} imported but not shimmed; ` +
    "120fps replaces the Next.js runtime modules it can render standalone and leaves the rest to " +
    "resolve from the project, where a module written for the Next.js server or its compiler " +
    "plugin can fail to load in the harness page"
  );
}

export function detectNextJs(projectRoot: string): boolean {
  return isPackageAvailable("next", projectRoot);
}

export function buildShimAliases(
  hasNextJs: boolean,
): Array<{ find: RegExp; replacement: string; isShim: boolean }> {
  if (!hasNextJs) return [];
  const shimDir = path.resolve(import.meta.dirname ?? __dirname, "shims");
  return SHIM_MODULES.map((entry) => {
    const escaped = entry.module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return {
      find: new RegExp(`^${escaped}$`),
      replacement: path.join(shimDir, entry.shimFile),
      isShim: true,
    };
  });
}

export interface ComponentIdentity {
  relative: string;
  name: string;
  isDefaultExport: boolean;
}

export interface HarnessResult {
  url: string;
  server: ViteDevServer;
  componentPath: string;
  harnessDir: string;
  cleanup: () => Promise<void>;
  component: ComponentIdentity;
  nextJsShims?: string[];
  wrapPath?: string;
  wrapRelative?: string;
  cssFiles?: string[];
  reactCompiler?: ReactCompilerState;
  // M78: the project's own vite.config resolve.alias entries, already merged
  // into this harness's own alias list (M71/M76) — so an alias that matches
  // "react-dom" genuinely changes what this server mounts, not just what a
  // manifest claims. resolveReactDomIdentity's second parameter reads this.
  viteAliases?: Array<{ find: RegExp; replacement: string }>;
  // M38: build-time advisories (e.g. a shared server whose frozen dep list
  // misses this component's scan). analyze() forwards them to the report.
  warnings?: string[];
}

// M38: the dev server's root is projectRoot and every harness dir lives under
// it, so one server per config tuple serves a whole sweep. Vite serves files
// created after boot on demand: later components need no restart.
export interface ServerPool {
  acquire(
    key: string,
    boot: () => Promise<ViteDevServer>,
    include: string[],
  ): Promise<{ server: ViteDevServer; reused: boolean; include: Set<string> }>;
  stats(): { booted: number };
  closeAll(): Promise<void>;
}

// M88: Vite's own dev-server teardown has a known shape (previously observed
// only in vitest's own dev-server teardown after an explicit
// transformRequest()) where server.close() never settles. Both callers that
// await a server's own close() -- buildAndServe's cleanup() and the pool's
// closeAll() below -- race it against an unref'd timer instead of awaiting it
// unconditionally, so a single hung server can never block the caller (and,
// transitively, the process from exiting) forever. Unref'd: this timer alone
// never keeps an otherwise-idle process alive, but a hung close() leaves
// other handles open regardless, so it still fires on schedule.
export const SERVER_CLOSE_TIMEOUT_MS = 5000;

export async function closeServerBounded(
  server: Pick<ViteDevServer, "close">,
  timeoutMs: number = SERVER_CLOSE_TIMEOUT_MS,
): Promise<void> {
  await Promise.race([
    server.close().catch(() => {}),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref();
    }),
  ]);
}

export function createServerPool(): ServerPool {
  // M56: once per session, best-effort: errors are swallowed inside the
  // sweep itself, so this can never fail or block pool creation.
  sweepStaleTmpDirs();
  const servers = new Map<string, Promise<{ server: ViteDevServer; include: Set<string> }>>();
  let closed = false;
  let booted = 0;
  return {
    async acquire(key, boot, include) {
      if (closed) throw new Error("server pool is closed");
      let entry = servers.get(key);
      let reused = true;
      if (!entry) {
        reused = false;
        booted++;
        // The include list is frozen at first boot: it is part of the Vite
        // config hash, and changing it per component would force a dep
        // re-bundle for every component of the sweep (M34).
        entry = boot().then((server) => ({ server, include: new Set(include) }));
        servers.set(key, entry);
      }
      const resolved = await entry;
      return { server: resolved.server, reused, include: resolved.include };
    },
    stats: () => ({ booted }),
    async closeAll() {
      closed = true;
      for (const entry of servers.values()) {
        try {
          await closeServerBounded((await entry).server);
        } catch {
          // Already closed, or boot failed: nothing left to release.
        }
      }
      servers.clear();
    },
  };
}

export function SWEEP_DEP_WARNING(missing: string[]): string {
  return (
    `shared sweep server was booted without ${missing.join(", ")} in its optimized deps; ` +
    "Vite discovers them on demand, which can reload the page once mid-run (retried automatically)"
  );
}

// M56: names both the cause (whatever Vite or the address check reported) and
// where: the one detail that turns "something failed" into something a user
// can act on (check the harness dir, or the underlying message, for why).
export function VITE_START_FAILED(harnessDir: string, detail: string): string {
  return `Failed to start Vite dev server in ${harnessDir}: ${detail}`;
}

// M73: the harness dir is created inside the project root by design (Vite's
// root is the project root, so the generated entry's root-absolute specifiers,
// the project's aliases, and its node_modules walk all resolve the way the app
// resolves them). A root that cannot be written to is therefore a refusal, and
// the raw EACCES that mkdtempSync throws says none of that.
export function HARNESS_DIR_UNWRITABLE(projectRoot: string, detail: string): string {
  return (
    `Cannot create the harness directory in ${projectRoot}: ${detail}. ` +
    "120fps writes its generated entry inside the project root so the project's own aliases and " +
    "node_modules resolve the way the app resolves them. Make that directory writable, or copy " +
    "the project to a writable location and measure it there."
  );
}

// M83 #7: harness directories created but not yet cleaned up. `cleanup`
// (the success path) and the bootServer catch's own rmSync (the common
// caught-and-rethrown failure path) both remove their entry as soon as they
// remove the directory. What is left in the set when the process actually
// exits is exactly the leftover a crash produces: `sweepStaleHarnessDirs`
// never removes a directory whose marker names a live process (and never one
// this process itself owns), so it cannot cover a directory the current run
// just abandoned, and a raw, unhandled exception (ant-design-F1's shape)
// bypasses every try/catch in this file entirely — the `process.on("exit")`
// handler below is the layer that still catches it, since Node's "exit"
// event fires after an uncaught exception terminates the process, not only
// on a graceful return.
const activeHarnessDirs = new Set<string>();

// M113 (base-ui-R1): on Windows a handle Chromium, the dev server or an
// esbuild worker still holds makes a removal throw EBUSY/EPERM/ENOTEMPTY, and
// that handle is gone milliseconds later. A single attempt turned a transient
// lock into a directory the developer found in `git status`.
export const HARNESS_DIR_REMOVAL_BUDGET_MS = 1000;
export const HARNESS_DIR_REMOVAL_MIN_ATTEMPTS = 5;
const HARNESS_DIR_REMOVAL_DELAY_MS = 200;
// Every outstanding directory together: a root full of locked leftovers must
// not push a signalled exit near the CLI's 8 s watchdog, so the per-directory
// budget above yields to this one.
export const HARNESS_SWEEP_BUDGET_MS = 1500;

// The codes a held handle produces. Anything else (ENOTDIR, a hostile
// injected remover) says the next attempt would fail the same way.
const HARNESS_DIR_RETRY_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY", "EMFILE", "ENFILE"]);

// The `process.on("exit")` handler permits synchronous work only, so the wait
// between attempts cannot be a timer.
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// maxRetries covers the handle that closes within a few milliseconds without
// leaving this function; the loop around it owns the budget, the injection
// point and the disclosure.
function removeHarnessDirOnce(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
}

// Returns the error code of the last failed attempt, or undefined once the
// directory is gone. Never throws: every caller is on a teardown path.
export function removeHarnessDirWithRetries(
  dir: string,
  remove: (dir: string) => void = removeHarnessDirOnce,
  deadline: number = Date.now() + HARNESS_SWEEP_BUDGET_MS,
): string | undefined {
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      remove(dir);
      return undefined;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const reason = code ?? (err as Error).message;
      if (code === undefined || !HARNESS_DIR_RETRY_CODES.has(code)) return reason;
      const spent = Date.now() - started;
      const budgetSpent =
        attempt >= HARNESS_DIR_REMOVAL_MIN_ATTEMPTS && spent >= HARNESS_DIR_REMOVAL_BUDGET_MS;
      if (budgetSpent || Date.now() >= deadline) return reason;
      sleepSync(Math.min(HARNESS_DIR_REMOVAL_DELAY_MS, deadline - Date.now()));
    }
  }
}

// The path as the developer sees it: what `ls` in the directory they started
// the run from would print.
function harnessDirDisplayPath(dir: string, cwd: string): string {
  const rel = path.relative(cwd, dir);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.replace(/\\/g, "/") : dir;
}

export function HARNESS_DIR_REMOVAL_FAILED_WARNING(dir: string, reason: string): string {
  return (
    `Could not remove the harness directory ${dir} (${reason}). It is this run's own scratch ` +
    "directory, not part of your project; remove it by hand, or the next run in this project will."
  );
}

// The body the `process.on("exit")` handler below runs, and the pass the CLI
// runs after the pools have closed. A directory whose removal failed stays in
// the set: that is what makes the second pass — after Chromium and the dev
// server have let go — able to see it at all.
export function removeActiveHarnessDirs(
  options: {
    retry?: boolean;
    // Injected so the failure path is testable without contriving a real
    // Windows lock; every caller uses the default.
    remove?: (dir: string) => void;
    cwd?: string;
  } = {},
): Array<{ dir: string; reason: string }> {
  const remove = options.remove ?? removeHarnessDirOnce;
  const cwd = options.cwd ?? process.cwd();
  const deadline = Date.now() + HARNESS_SWEEP_BUDGET_MS;
  const failures: Array<{ dir: string; reason: string }> = [];
  for (const dir of activeHarnessDirs) {
    let reason: string | undefined;
    if (options.retry) {
      reason = removeHarnessDirWithRetries(dir, remove, deadline);
    } else {
      try {
        remove(dir);
      } catch (err) {
        reason = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
      }
    }
    if (reason === undefined) activeHarnessDirs.delete(dir);
    else failures.push({ dir: harnessDirDisplayPath(dir, cwd), reason });
  }
  return failures;
}

// Exported so the mechanism is testable without triggering a real process exit
// — a test can call this directly (or synthesize the event via
// `process.emit("exit")`, which Node runs its listeners for exactly as a real
// exit would, since listeners cannot tell the two apart). One attempt per
// directory: this is the pass that runs while the handles are still open, and
// the CLI's post-close pass is the one that spends the retry budget.
export function sweepActiveHarnessDirs(): void {
  removeActiveHarnessDirs();
}

let exitSweepRegistered = false;
function registerHarnessDirExitSweep(): void {
  if (exitSweepRegistered) return;
  exitSweepRegistered = true;
  process.on("exit", sweepActiveHarnessDirs);
}
registerHarnessDirExitSweep();

// accessSync answers POSIX permission bits; the real mkdtempSync answers
// everything it cannot see (Windows ACLs, a read-only mount, a root that is a
// file or does not exist).
export function createHarnessDir(projectRoot: string): string {
  const fail = (err: unknown): never => {
    throw new Error(
      HARNESS_DIR_UNWRITABLE(projectRoot, err instanceof Error ? err.message : String(err)),
      { cause: err },
    );
  };
  try {
    fs.accessSync(projectRoot, fs.constants.W_OK);
  } catch (err) {
    return fail(err);
  }
  try {
    const dir = fs.mkdtempSync(path.join(projectRoot, ".120fps-harness-"));
    // M83 #7: tracked from the moment it exists, regardless of what happens
    // next — `cleanup()` and the bootServer catch's own rmSync both remove
    // it as soon as they remove the directory; anything left when the
    // process exits is a leftover the exit sweep above still has to catch.
    activeHarnessDirs.add(dir);
    // M101: the marker that lets a later run tell an abandoned directory from
    // one a live run is still writing into. Best-effort: a marker that cannot
    // be written costs the directory only the older, more conservative age
    // gate, and must never fail the run that was about to measure.
    try {
      fs.writeFileSync(path.join(dir, HARNESS_PID_FILE), `${process.pid}\n`);
    } catch {
      // Unwritable marker: sweepStaleHarnessDirs falls back to age alone.
    }
    return dir;
  } catch (err) {
    return fail(err);
  }
}

// M101 (V2 repro 5): the process that owns a harness directory, so a later run
// can remove an abandoned one immediately instead of waiting out an age gate
// that exists only because nothing knew whose directory it was.
export const HARNESS_PID_FILE = ".pid";

function harnessDirOwnerPid(dir: string): number | undefined {
  try {
    const pid = Number.parseInt(fs.readFileSync(path.join(dir, HARNESS_PID_FILE), "utf-8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

// M101 (review A6): the directory's own mtime stops advancing the moment the
// build finishes writing entry.tsx, so a run longer than the gate looks
// abandoned while it is measuring. The marker is the heartbeat instead, and
// the run refreshes it at every phase (see the CLI's onPhase).
function harnessDirHeartbeatMs(dir: string): number | undefined {
  try {
    return fs.statSync(path.join(dir, HARNESS_PID_FILE)).mtimeMs;
  } catch {
    return undefined;
  }
}

export function refreshHarnessDirMarkers(): void {
  for (const dir of activeHarnessDirs) {
    try {
      const now = new Date();
      fs.utimesSync(path.join(dir, HARNESS_PID_FILE), now, now);
    } catch {
      // Best-effort: a directory already removed, or a marker never written.
    }
  }
}

// Signal 0 sends nothing: it asks the OS whether the pid could be signalled.
// EPERM means the pid exists and belongs to someone else — alive, and not this
// run's directory to delete.
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// M73: the version is read from the project's own react-dom rather than
// resolveReactDomIdentity in src/react-profiler.ts, which imports values from
// this module: the reverse import would close a cycle.
function readReactDomVersion(projectRoot: string): string | undefined {
  try {
    const pkgPath = createRequire(path.join(projectRoot, "/")).resolve("react-dom/package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

export function REACT_DOM_CLIENT_MISSING(projectRoot: string, version: string | undefined): string {
  return (
    `React 18+ required${version ? ` (found react-dom v${version})` : ""}: ` +
    `react-dom/client does not resolve from ${projectRoot}. The harness mounts with createRoot ` +
    "from react-dom/client, which React 16 and 17 do not provide. Upgrade react-dom in the " +
    "project, or measure the component from a project on React 18 or newer."
  );
}

// M78: four field-tested repos hit this catch for four different real
// causes, and the old bare catch treated every one of them as "version too
// old" because readReactDomVersion fails the same way for all of them. The
// order matters: a package that genuinely resolves on disk with a real (too
// old) version is a version problem regardless of whether the project's own
// package.json happens to list it, so readReactDomVersion is checked before
// isPackageDeclared, not after.
type ReactDomResolutionCause =
  | "pnp"
  | "not-installed"
  | "not-declared"
  | "not-linked"
  | "outdated"
  | "unknown";

function diagnoseReactDomResolutionFailure(
  projectRoot: string,
): { cause: ReactDomResolutionCause; version?: string } {
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  if (detectPnP(workspaceRoot)) return { cause: "pnp" };
  if (detectMissingInstall(projectRoot, workspaceRoot)) return { cause: "not-installed" };
  const version = readReactDomVersion(projectRoot);
  if (version !== undefined) return { cause: "outdated", version };
  if (isPackageDeclared("react-dom", projectRoot, workspaceRoot)) return { cause: "not-linked" };
  return { cause: "not-declared" };
}

function reactDomNotDeclaredMessage(projectRoot: string, workspaceRoot: string): string {
  if (
    !isPackageDeclared("react", projectRoot, workspaceRoot) &&
    !isPackageDeclared("react-dom", projectRoot, workspaceRoot) &&
    isPackageDeclared("solid-js", projectRoot, workspaceRoot)
  ) {
    return (
      `react-dom/client does not resolve from ${projectRoot}: this project declares solid-js, ` +
      "not react or react-dom.\n\n" +
      hardRemedyFor("unsupported-framework")
    );
  }
  const workspaceClause =
    workspaceRoot !== projectRoot ? ` and workspace root ${workspaceRoot}` : "";
  return (
    `react-dom is not a dependency of this project (checked package.json at ${projectRoot}` +
    `${workspaceClause}); point 120fps at a project that declares it, or install it here.`
  );
}

function reactDomResolutionMessage(
  projectRoot: string,
  diagnosis: { cause: ReactDomResolutionCause; version?: string },
): string {
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  switch (diagnosis.cause) {
    case "pnp":
      return (
        `react-dom/client does not resolve from ${projectRoot}: this workspace installs via ` +
        "Yarn Plug'n'Play, which 120fps cannot resolve modules through.\n\n" +
        hardRemedyFor("yarn-pnp")
      );
    case "not-installed":
      return (
        `react-dom/client does not resolve from ${projectRoot}: this project has no installed ` +
        "dependencies (no node_modules under it or its workspace root).\n\n" +
        hardRemedyFor("not-installed")
      );
    case "not-declared":
      return reactDomNotDeclaredMessage(projectRoot, workspaceRoot);
    case "not-linked":
      return (
        `react-dom is declared in package.json but was not found installed under node_modules ` +
        `from ${projectRoot} up through ${workspaceRoot}; the install may be incomplete, or this ` +
        "workspace member is not linked to it. Reinstall dependencies."
      );
    case "outdated": {
      let message = REACT_DOM_CLIENT_MISSING(projectRoot, diagnosis.version);
      if (isPackageDeclared("preact", projectRoot, workspaceRoot)) {
        message +=
          " This project also declares preact; its preact/compat/client.js already implements " +
          "a createRoot/hydrateRoot shim, but 120fps has no flag to mount through it, so " +
          "upgrading react-dom is still the only supported path.";
      }
      return message;
    }
    case "unknown":
    default:
      return (
        `react-dom/client does not resolve from ${projectRoot}, and 120fps could not determine ` +
        "why: react-dom appears to be installed but its version could not be read."
      );
  }
}

// Checked before the server boots: react-dom/client is forced into
// optimizeDeps.include for every React run, and an unresolvable include aborts
// Vite's optimizer with an esbuild path dump instead of a version diagnosis.
export function assertReactDomClient(projectRoot: string): void {
  try {
    createRequire(path.join(projectRoot, "/")).resolve("react-dom/client");
  } catch {
    throw new Error(reactDomResolutionMessage(projectRoot, diagnoseReactDomResolutionFailure(projectRoot)));
  }
}

// M98 (I2, element-plus-F1). The refusal was right and its reason was wrong: a
// Vue project's render-function `.tsx` was reported as "react-dom is not a
// dependency of this project", which reads as an install problem and invites
// `npm i react-dom` — a remedy that cannot help, since `rendererFor` keys the
// mount on the file extension alone (`harness.ts:36`) and no Vue-JSX transform
// is loaded (`SUPPORTED_TRANSFORM_PLUGINS` carries `@vitejs/plugin-vue`, never
// `@vitejs/plugin-vue-jsx`).
export function VUE_PROJECT_REACT_FILE_ERROR(relativePath: string): string {
  return (
    `${relativePath} is a ${path.extname(relativePath)} file in a Vue project (this project ` +
    "declares vue and not react-dom). 120fps mounts Vue components from " +
    ".vue single-file components only, so a Vue JSX / render-function file has no mount path " +
    "here; --framework vue cannot change that, because a component always mounts by its file " +
    "extension. Point 120fps at this component's .vue SFC, or measure the file in a project " +
    "that declares react-dom."
  );
}

// Asked before the react-dom question, on both the dry-run and the real-run
// path, so the two agree on which question the file actually fails. A project
// that declares react-dom is left to `assertReactDomClient` exactly as before:
// this gate only claims the case where no React mount could exist at all.
export function assertRendererSupported(componentPath: string, projectRoot: string): void {
  if (rendererFor(componentPath) !== "react") return;
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  if (isPackageDeclared("react-dom", projectRoot, workspaceRoot)) return;
  if (detectFramework(projectRoot) !== "vue") return;
  const relative = path.relative(projectRoot, path.resolve(componentPath)).replace(/\\/g, "/");
  throw new Error(VUE_PROJECT_REACT_FILE_ERROR(relative === "" ? componentPath : relative));
}

// M73: path.win32.relative("C:\\proj", "D:\\x") returns "D:\\x" — two drives
// have no common ancestor to walk up to, so the result is absolute and carries
// no "..". A caller reading only the "../" prefix takes another drive for an
// in-root path. The platform parameter makes the drive-letter behavior
// observable from a test on any host.
export function isOutsideRoot(
  target: string,
  root: string,
  platform: path.PlatformPath = path,
): boolean {
  const relative = platform.relative(root, target);
  return (
    relative === ".." || relative.startsWith(".." + platform.sep) || platform.isAbsolute(relative)
  );
}

// The body of the entry's import specifier: the generators embed it as
// `from "/${componentRelative}"`, so an out-of-root component becomes
// "/@fs/<posix-absolute>", the same escape hatch cssImportSpecifier already
// uses for an out-of-root stylesheet.
export function componentImportPath(
  componentPath: string,
  projectRoot: string,
  platform: path.PlatformPath = path,
): string {
  if (isOutsideRoot(componentPath, projectRoot, platform)) {
    return "@fs/" + componentPath.replace(/\\/g, "/").replace(/^\//, "");
  }
  return platform.relative(projectRoot, componentPath).replace(/\\/g, "/");
}

export interface BuildHarnessOptions {
  composition?: CompositionTree;
  exports?: ExportInfo[];
  noShims?: boolean;
  wrapPath?: string;
  cssFiles?: string[];
  reactCompiler?: boolean;
  // M38: reuse one dev server per config tuple across a sweep.
  serverPool?: ServerPool;
  // M44: absolute path to a `<stem>.props.tsx` preset module, imported by the
  // entry so non-serializable preset values resolve in the page.
  presetPath?: string;
  // M48: skip the project's own Vite transforms (measure what the harness can
  // compile on its own).
  noTransforms?: boolean;
  // M65: the export named by `<file>#Export`, imported instead of the one the
  // selection order would pick.
  target?: string;
}

// M100 (I5): every pre-build fact `buildAndServe` derives from the filesystem
// alone — no bundler, no dev server, no browser. `--explain-props` refused to
// start a server and therefore never saw any of it (V6's rows 5, 17-21), so a
// dry run was silent about a broken vite.config alias, an unbuilt workspace
// dist/, a type-only package, an unsupported Next module and a missing style
// engine, all of which the real run reported seconds later.
export interface StaticPreBuild {
  warnings: string[];
  viteConfig: ViteConfigData;
  // M109 (A5): the conditions the dev server resolves exports under — the vite
  // config's own list, then the governing tsconfig's customConditions.
  resolveConditions: string[];
  externalDeps: string[];
  styleTooling: StyleTooling;
  nextModules: { detected: boolean; activeShims?: string[]; unsupported: string[] };
  // Consumed by buildAndServe, which must not rebuild them: `scanExternalDeps`
  // appends its workspace-source rescue aliases (M94) to this same array.
  aliases: Array<{
    find: RegExp;
    replacement: string;
    isShim?: boolean;
    fromWorkspaceRoot?: WorkspaceRootAliasSource;
  }>;
  importedSpecifiers: Set<string>;
  // M110 (A2/I2, epic-stack-F2): every specifier the scan could not resolve to
  // a package, an alias or an `imports` entry, so both modes report the same
  // set without walking the graph again.
  unresolvedExternals: Array<{ specifier: string; importer: string }>;
  workspaceRoot: string;
}

// Probe order is significant: first hit wins, and detection returns at most one.
// M71: the create-vite name and the Sass spellings are appended, so every path
// that already won still wins.
export const GLOBAL_CSS_CANDIDATES = [
  "app/globals.css",
  "app/global.css",
  "src/app/globals.css",
  "src/app/global.css",
  "src/styles/globals.css",
  "styles/globals.css",
  "src/index.css",
  "src/global.css",
  "src/style.css",
  // M102 (heroui-F1): the plural spelling, one character away from the line
  // above and the name heroui's own `exports["./styles"]` points at.
  "src/styles.css",
  "app/globals.scss",
  "app/global.scss",
  "src/app/globals.scss",
  "src/app/global.scss",
  "src/styles/globals.scss",
  "styles/globals.scss",
  "src/index.scss",
  "src/global.scss",
  "src/style.scss",
];

export function detectGlobalCss(projectRoot: string): string | undefined {
  for (const candidate of GLOBAL_CSS_CANDIDATES) {
    const full = path.join(projectRoot, candidate);
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch {
      // missing or unreadable: try the next candidate
    }
  }
  return undefined;
}

export const STYLESHEET_EXTENSIONS = [".css", ".scss", ".sass", ".less", ".styl"];

// Vite fails the whole entry module with "Preprocessor dependency … not found"
// when the compiler is absent, which costs the run rather than the stylesheet.
const PREPROCESSOR_PACKAGES: Record<string, string[]> = {
  ".scss": ["sass", "sass-embedded"],
  ".sass": ["sass", "sass-embedded"],
  ".less": ["less"],
  ".styl": ["stylus"],
};

function isStylesheet(file: string): boolean {
  return STYLESHEET_EXTENSIONS.includes(path.extname(file).toLowerCase());
}

// A CSS module exports class names; injecting one globally measures a stylesheet
// the application never loads globally.
function isCssModule(file: string): boolean {
  return /\.module\.[^.]+$/i.test(path.basename(file));
}

// M82: a reset/normalize library's own convention. Opt-in everywhere it
// appears, so the name alone disqualifies it from the largest-stylesheet
// fallback regardless of rule count.
export const RESET_STYLESHEET_STEMS = ["reset", "normalize", "preflight", "sanitize"];

export function isOptInResetName(file: string): boolean {
  const stem = path.basename(file, path.extname(file)).toLowerCase();
  return RESET_STYLESHEET_STEMS.includes(stem);
}

// M82: text-only heuristic, matching the "text only, nothing executed"
// invariant M71 set for readViteConfigData. Strips comments and
// @import/@charset/@use statements, then counts remaining `{` occurrences.
// Zero means the file is a pure passthrough: nothing was ever built into it.
const STYLESHEET_RULE_COUNT_MAX_BYTES = 2 * 1024 * 1024;

export function stylesheetRuleCount(file: string): number {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return 0;
  }
  // Too large to be worth reading this early in the pipeline; a file this big
  // is not an unbuilt placeholder, so it is treated as plausible.
  if (size > STYLESHEET_RULE_COUNT_MAX_BYTES) return 1;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return 0;
  }
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@(?:import|charset|use)\b[^;]*;/gi, "");
  return (stripped.match(/\{/g) ?? []).length;
}

// M102: a stylesheet's own `@import` statements, one hop, at the same text
// level `stylesheetRuleCount` works at — comments stripped, `url()` and quotes
// normalized, a media query or `layer()` suffix and a `?query` dropped. No CSS
// parser (M82's non-goal), and no recursion: one hop answers every shape the
// corpus produced (a passthrough that re-exports a package's real stylesheet,
// and an entry stylesheet importing an unbuilt package subpath).
const STYLESHEET_IMPORT_STATEMENT = /@import\s+(url\(\s*)?("([^"]*)"|'([^']*)')/gi;

export function stylesheetImportSpecifiers(file: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const specifiers: string[] = [];
  STYLESHEET_IMPORT_STATEMENT.lastIndex = 0;
  for (const match of stripped.matchAll(STYLESHEET_IMPORT_STATEMENT)) {
    const raw = (match[3] ?? match[4] ?? "").split("?")[0].trim();
    if (raw) specifiers.push(raw);
  }
  return specifiers;
}

// The three answers a bundler's own resolution can give, kept apart because
// they mean different things to a user: a file to inject, a path the package
// declares and has not produced (shadcn's `dist/tailwind.css`: the run must say
// which build to run), and nothing at all.
export type StylesheetImportTarget = { file: string } | { declared: string } | undefined;

// A bare package root ("@heroui/styles") is not a subpath, so
// resolveBareStylesheetSpecifier declines it by construction. The package's own
// manifest still names its stylesheet, in the same two fields a bundler's
// "style" condition reads.
function packageRootStylesheet(pkg: string, fromDir: string): StylesheetImportTarget {
  const pkgDir = installedPackageDir(pkg, fromDir);
  if (!pkgDir) return undefined;
  const manifest = readProjectManifest(pkgDir);
  if (!manifest) return undefined;
  const dot = manifest.exports && typeof manifest.exports === "object" && !Array.isArray(manifest.exports)
    ? (manifest.exports as Record<string, unknown>)["."]
    : undefined;
  const conditions =
    dot && typeof dot === "object" && !Array.isArray(dot) ? (dot as Record<string, unknown>) : {};
  const declared = [conditions.style, conditions.default, manifest.style].find(
    (value): value is string => typeof value === "string" && isStylesheet(value),
  );
  if (!declared) return undefined;
  const resolved = path.resolve(pkgDir, declared);
  return isFile(resolved) ? { file: resolved } : { declared: resolved };
}

// The lookup order a preprocessor applies to an extension-less import: the
// file itself, its underscore-prefixed partial, and the directory's own index
// partial, per language. Returns undefined when none of them exists — unknown,
// never "missing".
const PREPROCESSOR_PARTIAL_EXTENSIONS = [".scss", ".sass", ".less", ".styl", ".css"];

export function resolvePreprocessorPartial(base: string): string | undefined {
  const dir = path.dirname(base);
  const name = path.basename(base);
  for (const extension of PREPROCESSOR_PARTIAL_EXTENSIONS) {
    const candidates = [
      path.join(dir, name + extension),
      path.join(dir, "_" + name + extension),
      path.join(base, "_index" + extension),
      path.join(base, "index" + extension),
    ];
    for (const candidate of candidates) {
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

export function resolveStylesheetImportTarget(
  specifier: string,
  fromFile: string,
  projectRoot: string,
  aliases: Array<{ find: RegExp; replacement: string }>,
): StylesheetImportTarget {
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return undefined; // http(s):, data:
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const resolved = specifier.startsWith("/")
      ? path.join(projectRoot, specifier)
      : path.resolve(path.dirname(fromFile), specifier);
    if (isFile(resolved)) return { file: resolved };
    // A specifier that names its own extension and is not there really is
    // missing, and the caller may say so (shadcn's `dist/tailwind.css`). An
    // extension-less one is the canonical Sass/Less partial form — ant-design's
    // `@import "../variables"`, primevue's `@import './_mixins'` — where the
    // file on disk is spelled differently by design. Claiming it missing named
    // a path that exists nowhere, which is the exact defect M102's third MUST
    // was written to remove.
    if (isStylesheet(resolved)) return { declared: resolved };
    const partial = resolvePreprocessorPartial(resolved);
    return partial ? { file: partial } : undefined;
  }
  for (const { find, replacement } of aliases) {
    if (!find.test(specifier)) continue;
    const target = path.resolve(specifier.replace(find, replacement));
    if (isFile(target)) return { file: target };
  }
  const fromDir = path.dirname(fromFile);
  const pkg = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
  if (specifier === pkg) return packageRootStylesheet(pkg, fromDir);
  const resolved = resolveBareStylesheetSpecifier(specifier, fromDir);
  if (resolved) return { file: resolved };
  return declaredBareStylesheetTarget(specifier, fromDir);
}

function preprocessorFor(file: string, memberRoot: string, workspaceRoot: string): string | undefined {
  const packages = PREPROCESSOR_PACKAGES[path.extname(file).toLowerCase()];
  if (!packages) return undefined;
  if (packages.some((pkg) => isPackageAvailable(pkg, memberRoot, workspaceRoot))) return undefined;
  return packages[0];
}

export function CSS_IMPORT_SKIPPED_WARNING(specifiers: string[]): string {
  return (
    `the project entry imports ${specifiers.join(", ")}, which resolved to no file the harness can serve; ` +
    "those stylesheets are not injected and the component may render unstyled"
  );
}

export function CSS_PREPROCESSOR_MISSING_WARNING(file: string, pkg: string): string {
  return (
    `${file} needs ${pkg}, which this project does not have installed; the stylesheet is not injected ` +
    "because Vite would fail the harness entry module instead"
  );
}

// M92 (excalidraw-F6): the pick IS ranked (by size, stated in `scope` below),
// so "no evidence behind it at all" overclaimed when this package has no
// entry of its own -- excalidraw's own case landed on the file the profile
// calls the correct design-token root, ranked there by size alone, not
// arbitrarily. What is actually missing is import-chain corroboration, not
// evidence outright; the low-confidence framing lives in the `Stylesheets:`
// summary line (formatStylesheetsLine, src/report.ts) this warning precedes.
export function CSS_FALLBACK_WARNING(
  relative: string,
  opts: { onlyCandidate: boolean; noEntryInPackage: boolean },
): string {
  const scope = opts.onlyCandidate
    ? "the only stylesheet found under this project"
    : "the largest stylesheet found under this project";
  const entryNote = opts.noEntryInPackage
    ? "; this package has no application entry (index.html or Next.js app/pages stem) of its " +
      "own, so no import chain corroborates the pick -- it is ranked by size alone"
    : "";
  return (
    `no entry stylesheet import and no conventional global stylesheet were found, so ${relative} ` +
    `was injected because it is ${scope}${entryNote}; pass --css to name the right one`
  );
}

// M82: a fallback candidate with rule count 0 was never built into anything
// the project would load as-is.
// M92 (dub-F2): rule count 0 means no brace-delimited rule survives stripping
// comments and @import/@charset/@use -- it does not mean the file's only
// content IS comments and imports. A pure `@tailwind base;`/`@tailwind
// components;`/`@tailwind utilities;` passthrough (three at-rules, zero
// comments, zero imports) also counts 0, so the old fixed claim was false for
// exactly that shape; this names what the count actually proves instead.
export function CSS_PLACEHOLDER_SKIPPED_WARNING(relative: string): string {
  return (
    `${relative} contains no CSS rule with a body of its own (comments, imports, and bare at-rules ` +
    "such as @tailwind don't count), so it was not used as the stylesheet fallback: an unbuilt " +
    "passthrough is not something the project would load as-is"
  );
}

// M82: a reset/normalize stylesheet is conventionally opt-in; a project that
// imports it deliberately reaches it through the entry layer and never falls
// this far.
export function CSS_RESET_SKIPPED_WARNING(relative: string): string {
  return (
    `${relative} looks like an opt-in reset/normalize stylesheet (by filename), so it was not used as ` +
    "the stylesheet fallback: those are conventionally imported deliberately, not auto-injected"
  );
}

export function CSS_DROPPED_WARNING(file: string): string {
  return (
    `auto-detected stylesheet ${file} does not exist and was dropped; an unresolvable import would have ` +
    "failed the whole harness entry module"
  );
}

// M71: only --css validated its input, and a specifier that resolves to nothing
// takes the entry module down with it. Every auto-detected path passes here.
export function validateCssFiles(files: string[], warningsOut?: string[]): string[] {
  const kept: string[] = [];
  for (const file of files) {
    if (isFile(file)) kept.push(file);
    else warningsOut?.push(CSS_DROPPED_WARNING(file));
  }
  return kept;
}

const NEXT_ENTRY_STEMS = ["app/layout", "src/app/layout", "pages/_app", "src/pages/_app"];
const ENTRY_EXTENSIONS = [".tsx", ".jsx", ".ts", ".js"];
const MODULE_SCRIPT_TAG = /<script\b[^>]*>/gi;

// The module the project's own toolchain starts from: what index.html loads, or
// the module Next.js renders every route through.
export function findProjectEntry(projectRoot: string): string | undefined {
  const html = path.join(projectRoot, "index.html");
  let markup: string | undefined;
  try {
    markup = fs.readFileSync(html, "utf-8");
  } catch {
    markup = undefined;
  }
  if (markup) {
    MODULE_SCRIPT_TAG.lastIndex = 0;
    for (const tag of markup.match(MODULE_SCRIPT_TAG) ?? []) {
      if (!/\btype\s*=\s*["']module["']/i.test(tag)) continue;
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
      if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src)) continue;
      const resolved = src.startsWith("/")
        ? path.join(projectRoot, src)
        : path.resolve(path.dirname(html), src);
      if (isFile(resolved)) return resolved;
    }
  }
  for (const stem of NEXT_ENTRY_STEMS) {
    for (const extension of ENTRY_EXTENSIONS) {
      const candidate = path.join(projectRoot, stem + extension);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

// M92 (twenty-F3): a bare package specifier ("twenty-ui/theme-light.css") is a
// real, resolvable stylesheet whenever the package's own exports map (or, in
// its absence, a plain directory join) names that subpath -- exactly the
// resolution a real bundler performs. A package can export some subpaths and
// not others, so this always resolves one full specifier's real status, never
// a whole batch's: the caller can tell a genuinely-missing file from one that
// resolves fine.
function resolveBareStylesheetSpecifier(specifier: string, fromDir: string): string | undefined {
  const target = bareStylesheetTarget(specifier, fromDir);
  return target && "file" in target ? target.file : undefined;
}

// M102: the same resolution, reporting a declared-but-absent target instead of
// discarding it. shadcn's `shadcn/tailwind.css` resolves through the package's
// own exports map to `dist/tailwind.css`, a directory that exists only after
// that package is built: a user needs that path named, not the specifier
// pasted onto a repository root.
function declaredBareStylesheetTarget(specifier: string, fromDir: string): StylesheetImportTarget {
  const target = bareStylesheetTarget(specifier, fromDir);
  return target && "declared" in target ? target : undefined;
}

function bareStylesheetTarget(specifier: string, fromDir: string): StylesheetImportTarget {
  const pkg = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
  const subpath = specifier.slice(pkg.length + 1);
  if (!subpath) return undefined;
  const pkgDir = installedPackageDir(pkg, fromDir);
  if (!pkgDir) return undefined;
  const exportsField = readProjectManifest(pkgDir)?.exports;
  if (exportsField && typeof exportsField === "object" && !Array.isArray(exportsField)) {
    const entry = (exportsField as Record<string, unknown>)[`./${subpath}`];
    const target =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && !Array.isArray(entry)
          ? ["default", "import", "require", "style"]
              .map((condition) => (entry as Record<string, unknown>)[condition])
              .find((value): value is string => typeof value === "string")
          : undefined;
    if (!target) return undefined;
    const resolved = path.resolve(pkgDir, target);
    return isFile(resolved) ? { file: resolved } : { declared: resolved };
  }
  const direct = path.resolve(pkgDir, subpath);
  return isFile(direct) ? { file: direct } : { declared: direct };
}

function resolveStylesheetSpecifier(
  specifier: string,
  entryFile: string,
  projectRoot: string,
  aliases: Array<{ find: RegExp; replacement: string }>,
): string | undefined {
  if (specifier.startsWith(".")) {
    const resolved = path.resolve(path.dirname(entryFile), specifier);
    return isFile(resolved) ? resolved : undefined;
  }
  if (specifier.startsWith("/")) {
    const resolved = path.join(projectRoot, specifier);
    return isFile(resolved) ? resolved : undefined;
  }
  for (const { find, replacement } of aliases) {
    if (!find.test(specifier)) continue;
    const target = path.resolve(specifier.replace(find, replacement));
    if (isFile(target)) return target;
  }
  return resolveBareStylesheetSpecifier(specifier, path.dirname(entryFile));
}

// The entry's own side-effect stylesheet imports, in import order. A bound
// import (`import styles from "./x.module.css"`) is a CSS module read, not a
// global stylesheet, and a deeper walk is out of scope: the file the project
// starts from is where a global stylesheet is loaded.
export function entryStylesheetImports(
  entryFile: string,
  projectRoot: string,
  aliases: Array<{ find: RegExp; replacement: string }>,
  warningsOut?: string[],
  workspaceRoot: string = findWorkspaceRoot(projectRoot),
): string[] {
  let sourceText: string;
  try {
    sourceText = fs.readFileSync(entryFile, "utf-8");
  } catch {
    return [];
  }
  const kind = /\.[jt]sx$/i.test(entryFile) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(entryFile, sourceText, ts.ScriptTarget.Latest, false, kind);

  const files: string[] = [];
  const unresolved: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text.split("?")[0];
    if (!specifier || !isStylesheet(specifier) || isCssModule(specifier)) continue;
    const resolved = resolveStylesheetSpecifier(specifier, entryFile, projectRoot, aliases);
    if (!resolved) {
      unresolved.push(specifier);
      continue;
    }
    const missing = preprocessorFor(resolved, projectRoot, workspaceRoot);
    if (missing) {
      warningsOut?.push(CSS_PREPROCESSOR_MISSING_WARNING(resolved, missing));
      continue;
    }
    if (!files.includes(resolved)) files.push(resolved);
  }
  if (unresolved.length > 0) warningsOut?.push(CSS_IMPORT_SKIPPED_WARNING(unresolved));
  return files;
}

const STYLESHEET_SCAN_SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "public",
  "storybook-static",
]);
const STYLESHEET_SCAN_MAX_DEPTH = 8;
const STYLESHEET_SCAN_MAX_ENTRIES = 4000;

// Bounded walk shared by the largest-stylesheet fallback and the ranked
// candidate list: a repository is big and this runs before anything is
// measured.
export function rankedStylesheets(projectRoot: string): Array<{ file: string; size: number }> {
  const found: Array<{ file: string; size: number }> = [];
  let visited = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > STYLESHEET_SCAN_MAX_DEPTH || visited >= STYLESHEET_SCAN_MAX_ENTRIES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= STYLESHEET_SCAN_MAX_ENTRIES) return;
      visited++;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || STYLESHEET_SCAN_SKIP_DIRS.has(entry.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isStylesheet(entry.name) || isCssModule(entry.name)) continue;
      let size: number;
      try {
        size = fs.statSync(full).size;
      } catch {
        continue;
      }
      found.push({ file: full, size });
    }
  };

  walk(projectRoot, 0);
  // Descending by size; ties break on path so one project always yields one
  // answer regardless of directory-traversal order.
  return found.sort((a, b) => b.size - a.size || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

// Last resort. Ties break on path so one project always yields one answer.
export function largestStylesheet(projectRoot: string): string | undefined {
  return rankedStylesheets(projectRoot)[0]?.file;
}

export interface CssDiscovery {
  files: string[];
  // M102: "package-declared" is a pick made from the measured package's own
  // manifest (`style`, `exports["./styles"]`, `exports[*].style`) — evidence
  // the package itself published, distinct from a conventional filename.
  source: "entry" | "package-declared" | "candidate" | "fallback" | "runtime" | "none";
  // present only when source === "fallback"
  onlyCandidate?: boolean;
  noEntryInPackage?: boolean;
  // present only when source === "runtime"
  runtimeEngines?: string[];
}

// M102 (heroui-F1): the fields a package uses to tell a bundler where its own
// stylesheet is. Read in the order a "style" condition would be looked up, and
// only for the measured package itself — never an ancestor application's
// manifest (M82).
export function packageStylesheetCandidates(projectRoot: string): string[] {
  const manifest = readProjectManifest(projectRoot);
  if (!manifest) return [];
  const declared: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === "string" && isStylesheet(value)) declared.push(value);
  };
  add(manifest.style);
  const exportsField = manifest.exports;
  if (exportsField && typeof exportsField === "object" && !Array.isArray(exportsField)) {
    const entries = exportsField as Record<string, unknown>;
    const styleOf = (entry: unknown): unknown =>
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>).style ?? (entry as Record<string, unknown>).default
          : undefined;
    add(styleOf(entries["./styles"]));
    add(styleOf(entries["./style.css"]));
    for (const [subpath, entry] of Object.entries(entries)) {
      if (subpath === "./styles" || subpath === "./style.css") continue;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      add((entry as Record<string, unknown>).style);
    }
  }
  const files: string[] = [];
  for (const value of declared) {
    const resolved = path.resolve(projectRoot, value);
    if (isFile(resolved) && !files.includes(resolved)) files.push(resolved);
  }
  return files;
}

export function CSS_PASSTHROUGH_RESOLVED_WARNING(candidate: string, targets: string[]): string {
  return (
    `${candidate} declares no CSS rule of its own; the stylesheet it imports, ${targets.join(", ")}, ` +
    "was injected in its place"
  );
}

export function CSS_BROKEN_IMPORT_SKIPPED_WARNING(file: string, specifier: string, target: string): string {
  return (
    `${file} imports "${specifier}", which resolves to ${target} — a file that does not exist, most ` +
    "likely because it is generated by a build this harness never runs. The stylesheet was not " +
    "injected and the component is measured unstyled; run that package's build, or pass --css to " +
    "name a stylesheet that resolves."
  );
}

// A candidate that carries rules is used as it is. A 0-rule passthrough
// (heroui's `src/styles.css`: a comment and one `@import`) stands for the
// stylesheet it imports, so that stylesheet is what gets injected.
function expandPassthroughStylesheet(
  candidate: string,
  projectRoot: string,
  aliases: Array<{ find: RegExp; replacement: string }>,
  warningsOut?: string[],
): string[] {
  if (stylesheetRuleCount(candidate) > 0) return [candidate];
  const resolved: string[] = [];
  for (const specifier of stylesheetImportSpecifiers(candidate)) {
    const target = resolveStylesheetImportTarget(specifier, candidate, projectRoot, aliases);
    if (target && "file" in target && !resolved.includes(target.file)) resolved.push(target.file);
  }
  if (resolved.length === 0) return [];
  warningsOut?.push(
    CSS_PASSTHROUGH_RESOLVED_WARNING(
      relativeToRoot(candidate, projectRoot),
      resolved.map((file) => relativeToRoot(file, projectRoot)),
    ),
  );
  return resolved;
}

function relativeToRoot(file: string, projectRoot: string): string {
  return path.relative(projectRoot, file).replace(/\\/g, "/");
}

// M102 (shadcn-ui-F1/F2): a stylesheet that resolves and reads fine can still
// fail to compile because something it imports does not exist — the condition
// the bundler used to discover, fatally for two of four components and
// recoverably for the other two depending on which surface its rejection
// reached. Decidable here, from the filesystem, before any server starts.
function brokenNestedImport(
  file: string,
  projectRoot: string,
  aliases: Array<{ find: RegExp; replacement: string }>,
): { specifier: string; target: string } | undefined {
  for (const specifier of stylesheetImportSpecifiers(file)) {
    const target = resolveStylesheetImportTarget(specifier, file, projectRoot, aliases);
    if (target && "declared" in target) return { specifier, target: target.declared };
  }
  return undefined;
}

// M71: evidence before convention. What the project's own entry imports is what
// the project loads; a filename list is a guess, and the largest stylesheet in
// the tree is a guess that says so.
// M82: the largest-stylesheet fallback distrusts itself before it fires (an
// unbuilt placeholder or an opt-in reset by name is skipped and warned about),
// and when nothing survives that walk, runtime CSS-in-JS is checked as a
// first-class "no static stylesheet was ever going to exist" outcome before
// falling all the way to "none".
// M102 (I6, mantine-F1): `extraEntryFiles` are files the harness itself mounts
// through (the resolved `--wrap`/`120fps.setup.*` module), read for their own
// side-effect stylesheet imports exactly as the project entry is. A wrapper is
// not an application entry, so it never changes `noEntryInPackage`: what it
// changes is whether a stylesheet the run really loads is disclosed.
export function discoverGlobalCss(
  projectRoot: string,
  warningsOut?: string[],
  opts?: { extraEntryFiles?: string[] },
): CssDiscovery {
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  const aliases = loadTsconfigAliases(projectRoot);
  // M102: a file rejected by one layer stays rejected for every later one —
  // shadcn's `app/globals.css` is both the entry's own import and a
  // conventional filename, and re-picking it one layer down would undo the
  // rejection the layer above just disclosed.
  const rejected = new Set<string>();
  const injectable = (file: string): boolean => {
    if (rejected.has(file)) return false;
    const broken = brokenNestedImport(file, projectRoot, aliases);
    if (!broken) return true;
    rejected.add(file);
    warningsOut?.push(
      CSS_BROKEN_IMPORT_SKIPPED_WARNING(
        relativeToRoot(file, projectRoot),
        broken.specifier,
        relativeToRoot(broken.target, projectRoot),
      ),
    );
    return false;
  };

  const entry = findProjectEntry(projectRoot);
  const entryFiles: string[] = [];
  for (const file of [...(entry ? [entry] : []), ...(opts?.extraEntryFiles ?? [])]) {
    const resolved = path.resolve(file);
    if (!entryFiles.includes(resolved)) entryFiles.push(resolved);
  }
  if (entryFiles.length > 0) {
    const imported: string[] = [];
    for (const entryFile of entryFiles) {
      const files = validateCssFiles(
        entryStylesheetImports(entryFile, projectRoot, aliases, warningsOut, workspaceRoot),
        warningsOut,
      );
      for (const file of files) if (!imported.includes(file)) imported.push(file);
    }
    const usable = imported.filter(injectable);
    if (usable.length > 0) return { files: usable, source: "entry" };
  }

  // M102 (heroui-F1): what the package says about itself, above a filename
  // convention and above the size-ranked guess.
  const declaredCandidates: Array<{ file: string; source: "package-declared" | "candidate" }> = [
    ...packageStylesheetCandidates(projectRoot).map((file) => ({
      file,
      source: "package-declared" as const,
    })),
    ...GLOBAL_CSS_CANDIDATES.map((name) => path.join(projectRoot, name))
      .filter(isFile)
      .map((file) => ({ file, source: "candidate" as const })),
  ];
  for (const { file: candidate, source } of declaredCandidates) {
    if (preprocessorFor(candidate, projectRoot, workspaceRoot)) continue;
    if (!injectable(candidate)) continue;
    const files = expandPassthroughStylesheet(candidate, projectRoot, aliases, warningsOut).filter(
      injectable,
    );
    if (files.length === 0) {
      // A passthrough that resolves to nothing: the same skip, and the same
      // disclosure, an unbuilt placeholder has always had. Recorded as
      // rejected so the ranked walk below skips it silently instead of
      // repeating the warning this layer just made.
      if (stylesheetRuleCount(candidate) === 0) {
        rejected.add(candidate);
        warningsOut?.push(CSS_PLACEHOLDER_SKIPPED_WARNING(relativeToRoot(candidate, projectRoot)));
      }
      continue;
    }
    return { files, source };
  }

  const ranked = rankedStylesheets(projectRoot);
  let survivor: { file: string; size: number } | undefined;
  for (const candidate of ranked) {
    const relative = path.relative(projectRoot, candidate.file).replace(/\\/g, "/");
    if (rejected.has(candidate.file)) continue;
    if (stylesheetRuleCount(candidate.file) === 0) {
      warningsOut?.push(CSS_PLACEHOLDER_SKIPPED_WARNING(relative));
      continue;
    }
    if (isOptInResetName(candidate.file)) {
      warningsOut?.push(CSS_RESET_SKIPPED_WARNING(relative));
      continue;
    }
    // Preprocessor-missing is not one of the two disqualification checks: it
    // stops the walk (matching the pre-M82 single-candidate behavior) rather
    // than skipping to the next-ranked candidate.
    if (!preprocessorFor(candidate.file, projectRoot, workspaceRoot) && injectable(candidate.file)) {
      survivor = candidate;
    }
    break;
  }

  if (survivor) {
    const relative = path.relative(projectRoot, survivor.file).replace(/\\/g, "/");
    const onlyCandidate = ranked.length === 1;
    const noEntryInPackage = !entry;
    warningsOut?.push(CSS_FALLBACK_WARNING(relative, { onlyCandidate, noEntryInPackage }));
    return { files: [survivor.file], source: "fallback", onlyCandidate, noEntryInPackage };
  }

  const runtimeEngines = detectRuntimeStyleEngines(projectRoot, workspaceRoot);
  if (runtimeEngines.length > 0) return { files: [], source: "runtime", runtimeEngines };

  return { files: [], source: "none" };
}

// M82: styling generated live in the browser, so no static stylesheet was
// ever going to exist. Checked only once the fallback layer's ranked walk has
// no survivor — never before layers 1-3, and never as a reason to skip a real
// find.
export const RUNTIME_STYLE_ENGINES = [
  "@ant-design/cssinjs",
  "@emotion/react",
  "@emotion/styled",
  "@emotion/css",
  "styled-components",
  "primevue",
];

export function detectRuntimeStyleEngines(
  projectRoot: string,
  workspaceRoot: string = findWorkspaceRoot(projectRoot),
): string[] {
  return RUNTIME_STYLE_ENGINES.filter((pkg) => isPackageAvailable(pkg, projectRoot, workspaceRoot));
}

// Vite's root is projectRoot, so an in-root stylesheet uses the same
// root-absolute form as the component import. Anything else needs /@fs/.
export function cssImportSpecifier(cssFile: string, projectRoot: string): string {
  const relative = path.relative(projectRoot, cssFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return "/@fs/" + cssFile.replace(/\\/g, "/");
  }
  return "/" + relative.replace(/\\/g, "/");
}

export function cssImportBlock(specifiers?: string[]): string {
  if (!specifiers || specifiers.length === 0) return "";
  return specifiers.map((s) => `import "${s}";`).join("\n") + "\n";
}

export function detectTailwindVite(projectRoot: string): boolean {
  return isPackageAvailable("@tailwindcss/vite", projectRoot);
}

// Loaded from the project's own node_modules: the harness never carries a
// Tailwind version of its own. Import failure is non-fatal: PostCSS may still
// be configured, and a missing plugin must not abort a measurement run.
export async function loadTailwindVitePlugin(projectRoot: string): Promise<unknown[]> {
  try {
    const require = createRequire(path.join(projectRoot, "/"));
    const entry = require.resolve("@tailwindcss/vite");
    const mod = await import(pathToFileURL(entry).href);
    const factory = mod.default ?? mod;
    if (typeof factory !== "function") {
      throw new Error("@tailwindcss/vite has no callable default export");
    }
    const plugin = factory();
    return Array.isArray(plugin) ? plugin : [plugin];
  } catch (err) {
    process.stderr.write(
      `Warning: could not load @tailwindcss/vite from ${projectRoot}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return [];
  }
}

// M71: styling generated by a build step the harness does not run. Recognized
// so an unstyled-looking number is explainable; no plugin is ever loaded.
export const UNSUPPORTED_STYLE_ENGINES = [
  "unocss",
  "@unocss/vite",
  "@linaria/vite",
  "@linaria/core",
  "@pandacss/dev",
];

// M83 #6 (twenty-F5): package/resolution-chain availability alone used to be
// sufficient — a workspace member could declare @linaria/core and get the
// warning on every component in it, including one whose own import graph
// never touches it. `importedPackages` is the same `externalDeps` list the
// harness already builds from the measured component's (and wrapper's)
// resolved imports; membership there, not manifest/resolution-chain
// availability, is what earns this warning now.
export function detectUnsupportedStyleEngines(
  _projectRoot: string,
  _workspaceRoot: string,
  importedPackages: readonly string[],
): string[] {
  return UNSUPPORTED_STYLE_ENGINES.filter((pkg) => importedPackages.includes(pkg));
}

export function UNSUPPORTED_STYLE_ENGINE_WARNING(packages: string[]): string {
  return (
    `${packages.join(", ")} generates styles through a build step this harness does not run, so that ` +
    "styling is not replicated and the component may measure unstyled"
  );
}

// postcss-load-config's own search places, minus package.json.
const POSTCSS_CONFIG_FILES = [
  "postcss.config.ts",
  "postcss.config.cts",
  "postcss.config.mts",
  "postcss.config.js",
  "postcss.config.cjs",
  "postcss.config.mjs",
  ".postcssrc",
  ".postcssrc.json",
  ".postcssrc.yaml",
  ".postcssrc.yml",
  ".postcssrc.ts",
  ".postcssrc.cts",
  ".postcssrc.mts",
  ".postcssrc.js",
  ".postcssrc.cjs",
  ".postcssrc.mjs",
];

// Verified against the installed Vite 6.4.2: resolvePostcssConfig searches from
// its root up to searchForWorkspaceRoot(root) inclusive, and that helper knows
// only pnpm-workspace.yaml, lerna.json, and a package.json "workspaces" field.
// A repo whose root carries a lockfile alone stops Vite's walk at the member,
// so an inherited config is found here and passed in by hand. A member with its
// own config needs nothing: Vite's first level is already that directory.
export function findPostcssConfigAbove(
  memberRoot: string,
  workspaceRoot: string = findWorkspaceRoot(memberRoot),
): string | undefined {
  const hasConfig = (dir: string): boolean =>
    POSTCSS_CONFIG_FILES.some((name) => isFile(path.join(dir, name)));
  if (hasConfig(memberRoot)) return undefined;
  for (const level of workspaceLevels(memberRoot, workspaceRoot).slice(1)) {
    if (hasConfig(level)) return level;
  }
  return undefined;
}

// M111 A1 (midday-F1): Tailwind 3 has no Vite plugin of its own; it enters
// through PostCSS, and `resolveDefaultConfigPath` resolves `tailwind.config.*`
// against `process.cwd()`. A run started at the repository root of a monorepo
// therefore built a workspace member with Tailwind's *default* config -- empty
// `content`, no theme extension -- and `@apply` threw inside PostCSS. The
// config the member is built with has to come from the member, not the shell.
export const TAILWIND_CONFIG_FILES = [
  "tailwind.config.js",
  "tailwind.config.cjs",
  "tailwind.config.mjs",
  "tailwind.config.ts",
];

// Member first, then each ancestor up to and including the workspace root:
// Vite's own PostCSS search order, so the file found here is the file the
// pipeline would have used had it been started in the member.
function findPostcssConfigFile(memberRoot: string, workspaceRoot: string): string | undefined {
  for (const level of workspaceLevels(memberRoot, workspaceRoot)) {
    for (const name of POSTCSS_CONFIG_FILES) {
      const candidate = path.join(level, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

// `@tailwindcss/postcss` and `@tailwindcss/vite` are the version-4 entries; the
// bare `tailwindcss` plugin name is the version-3 one.
function postcssTextDeclaresBareTailwind(text: string): boolean {
  return /(?<![@\w/-])tailwindcss(?![\w/-])/.test(text);
}

// Installed metadata first, the declared range second: a fixture or a member
// measured before its install still states which major it means.
function tailwindMajor(memberRoot: string, workspaceRoot: string): number | undefined {
  const versions: string[] = [];
  // Bounded by the workspace: an install above the workspace root belongs to
  // whatever checkout this project happens to sit inside, not to this project.
  for (const level of workspaceLevels(memberRoot, workspaceRoot)) {
    const manifest = readProjectManifest(path.join(level, "node_modules", "tailwindcss"));
    if (typeof manifest?.version === "string") {
      versions.push(manifest.version);
      break;
    }
  }
  for (const level of workspaceLevels(memberRoot, workspaceRoot)) {
    const manifest = readProjectManifest(level);
    for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
      const deps = manifest?.[field] as Record<string, unknown> | undefined;
      const range = deps?.tailwindcss;
      if (typeof range === "string") versions.push(range);
    }
  }
  for (const version of versions) {
    const major = /(\d+)/.exec(version);
    if (major) return Number(major[1]);
  }
  return undefined;
}

export interface Tailwind3Pipeline {
  postcssConfigFile: string;
  configPath?: string;
  searched: string[];
}

// Undefined when nothing about this member is a Tailwind 3 PostCSS pipeline:
// no PostCSS config, a config that names no bare `tailwindcss` entry, or a
// major other than 3. The start directory is not an input -- that is the whole
// point of the milestone -- so it appears only in the message A3 builds.
export function resolveTailwind3Config(
  memberRoot: string,
  workspaceRoot: string = findWorkspaceRoot(memberRoot),
): Tailwind3Pipeline | undefined {
  if (detectTailwindVite(memberRoot)) return undefined;
  const postcssConfigFile = findPostcssConfigFile(memberRoot, workspaceRoot);
  if (postcssConfigFile === undefined) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(postcssConfigFile, "utf-8");
  } catch {
    return undefined;
  }
  if (!postcssTextDeclaresBareTailwind(text)) return undefined;
  const major = tailwindMajor(memberRoot, workspaceRoot);
  if (major !== undefined && major !== 3) return undefined;
  const searched = workspaceLevels(memberRoot, workspaceRoot);
  for (const level of searched) {
    for (const name of TAILWIND_CONFIG_FILES) {
      const candidate = path.join(level, name);
      if (isFile(candidate)) return { postcssConfigFile, configPath: candidate, searched };
    }
  }
  return { postcssConfigFile, searched };
}

// M111 A3. Names what was looked for, where, and the directory this run was
// started in, because that directory is what Tailwind falls back to once the
// search comes back empty. It never names a build script: no script produces a
// config the repository does not carry.
export function TAILWIND3_CONFIG_MISSING_WARNING(searched: string[], startDir: string): string {
  return (
    `This project builds its CSS with Tailwind 3 through PostCSS, but none of ` +
    `${TAILWIND_CONFIG_FILES.join(", ")} was found in ${searched.join(", ")}. ` +
    `Tailwind then resolves its config from the directory the run started in ` +
    `(${startDir}) and falls back to its default config, whose content list is empty: ` +
    `utility classes and @apply rules resolve to nothing. Add one of those files to ${searched[0]}.`
  );
}

interface PostcssPluginDeclaration {
  name?: string;
  options?: unknown;
  instance?: unknown;
}

// The member's own config file decides the plugin list. Loaded, not parsed:
// the object map and the array forms both reach the same declarations, and a
// plugin the member instantiated itself passes through untouched.
async function readPostcssPluginDeclarations(
  file: string,
): Promise<PostcssPluginDeclaration[] | undefined> {
  if (![".js", ".cjs", ".mjs"].includes(path.extname(file))) return undefined;
  let config: unknown;
  try {
    config = createRequire(file)(file);
  } catch {
    const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
    config = mod.default ?? mod;
  }
  const plugins = (config as { plugins?: unknown } | undefined)?.plugins;
  if (Array.isArray(plugins)) {
    return plugins.map((entry) => {
      if (typeof entry === "string") return { name: entry };
      if (Array.isArray(entry) && typeof entry[0] === "string") {
        return { name: entry[0], options: entry[1] };
      }
      return { instance: entry };
    });
  }
  if (plugins && typeof plugins === "object") {
    return Object.entries(plugins as Record<string, unknown>)
      // PostCSS's object form disables a plugin with `false`. A disabled entry
      // is not part of the pipeline the member declared, so it produces none.
      .filter(([, options]) => options !== false)
      .map(([name, options]) => ({
      name,
      ...(options === true || options === null || options === undefined ? {} : { options }),
    }));
  }
  return undefined;
}

// M111 A1: the member's pipeline rebuilt with one difference -- its Tailwind 3
// entry receives the config path resolved from the member. Every other plugin
// the member declared keeps its own options and its own place in the order.
// Any failure returns undefined, which leaves the run on the directory-search
// behaviour it had before: a stylesheet decision is never worth aborting for.
// M111 A2 (midday-F1): Tailwind 3 resolves a relative `content` glob against
// `process.cwd()`, so the same config generated different CSS from different
// shell directories. This writes the member's config back out with every
// relative glob anchored to the member root and returns the generated file's
// path. A path, not an object: Tailwind's context cache is keyed by the config
// file path, and an object config rebuilds that context on every build.
export function writeAnchoredTailwind3Config(
  memberRoot: string,
  tailwindConfigPath: string,
  outputDir: string,
): string {
  const loadConfigPath = createRequire(path.join(memberRoot, "/")).resolve(
    "tailwindcss/loadConfig",
  );
  const generated = path.join(outputDir, "tailwind.anchored.config.cjs");
  const source = [
    `// Generated by 120fps: the member's own Tailwind config, with every relative`,
    "// `content` glob resolved against the member root instead of the directory",
    "// this run started in.",
    `const path = require("node:path");`,
    `const loaded = require(${JSON.stringify(loadConfigPath)});`,
    "const loadConfig = loaded.default || loaded;",
    `const base = ${JSON.stringify(memberRoot)};`,
    `const config = loadConfig(${JSON.stringify(tailwindConfigPath)});`,
    "const anchor = (glob) => {",
    `  if (typeof glob !== "string") return glob;`,
    `  const negated = glob.startsWith("!");`,
    "  const body = negated ? glob.slice(1) : glob;",
    "  if (path.isAbsolute(body)) return glob;",
    `  return (negated ? "!" : "") + path.resolve(base, body).split(path.sep).join("/");`,
    "};",
    "const content = config.content;",
    "module.exports = Array.isArray(content)",
    "  ? { ...config, content: content.map(anchor) }",
    `  : content && typeof content === "object"`,
    "    ? { ...config, content: { ...content, files: (content.files || []).map(anchor) } }",
    "    : config;",
    "",
  ].join("\n");
  fs.writeFileSync(generated, source);
  return generated;
}

export async function loadTailwind3PostcssPipeline(
  memberRoot: string,
  postcssConfigFile: string,
  tailwindConfigPath: string,
  outputDir?: string,
  onWarning?: (warning: string) => void,
): Promise<{ plugins: unknown[] } | undefined> {
  try {
    const declared = await readPostcssPluginDeclarations(postcssConfigFile);
    // A plugin list this reader cannot read -- a `.ts` postcss config, or a
    // `plugins` value that is neither an array nor an object -- leaves the run
    // on the directory-dependent search. Disclosed, never silent.
    if (declared === undefined) {
      onWarning?.(
        `Could not read a plugin list from ${postcssConfigFile}: Tailwind resolves its own config ` +
          `from the directory this run started in, so the result depends on that directory.`,
      );
      return undefined;
    }
    let configPath = tailwindConfigPath;
    if (outputDir !== undefined) {
      try {
        configPath = writeAnchoredTailwind3Config(memberRoot, tailwindConfigPath, outputDir);
      } catch (err) {
        onWarning?.(
          `Could not anchor the content globs of ${tailwindConfigPath} to ${memberRoot} ` +
            `(${err instanceof Error ? err.message : String(err)}): a relative glob in that config ` +
            `resolves against the directory this run started in, so the CSS built depends on it.`,
        );
      }
    }
    const require = createRequire(path.join(memberRoot, "/"));
    const plugins: unknown[] = [];
    for (const entry of declared) {
      if (entry.name === undefined) {
        plugins.push(entry.instance);
        continue;
      }
      // A member that already pinned a config path had no directory dependence
      // to take away, so its own value stands.
      const declaredConfig = (entry.options as Record<string, unknown> | undefined)?.config;
      const options =
        entry.name === "tailwindcss" && declaredConfig === undefined
          ? {
              ...(entry.options as Record<string, unknown> | undefined),
              config: configPath,
            }
          : entry.options;
      const loaded = (await import(pathToFileURL(require.resolve(entry.name)).href)) as {
        default?: unknown;
      };
      const factory = loaded.default ?? loaded;
      plugins.push(
        typeof factory === "function"
          ? (factory as (o?: unknown) => unknown)(options)
          : factory,
      );
    }
    return { plugins };
  } catch (err) {
    onWarning?.(
      `Could not rebuild the PostCSS pipeline from ${postcssConfigFile} with an explicit Tailwind ` +
        `config (${err instanceof Error ? err.message : String(err)}): Tailwind resolves its own ` +
        `config from the directory this run started in, so the result depends on that directory.`,
    );
    return undefined;
  }
}

export interface StyleTooling {
  tailwind: boolean;
  unsupportedEngines: string[];
  postcssConfigDir?: string;
  tailwind3ConfigPath?: string;
  tailwind3PostcssConfigFile?: string;
  warnings: string[];
}

// M71: the Tailwind plugin generates utility CSS for the classes the measured
// component uses. Whether a global stylesheet was also found says nothing about
// whether it is needed, so no stylesheet list reaches this decision.
export function resolveStyleTooling(
  projectRoot: string,
  workspaceRoot: string = findWorkspaceRoot(projectRoot),
  importedPackages: readonly string[] = [],
  startDir: string = process.cwd(),
): StyleTooling {
  const unsupportedEngines = detectUnsupportedStyleEngines(projectRoot, workspaceRoot, importedPackages);
  const postcssConfigDir = findPostcssConfigAbove(projectRoot, workspaceRoot);
  const tailwind3 = resolveTailwind3Config(projectRoot, workspaceRoot);
  const warnings =
    unsupportedEngines.length > 0 ? [UNSUPPORTED_STYLE_ENGINE_WARNING(unsupportedEngines)] : [];
  if (tailwind3 && tailwind3.configPath === undefined) {
    warnings.push(TAILWIND3_CONFIG_MISSING_WARNING(tailwind3.searched, startDir));
  }
  return {
    tailwind: detectTailwindVite(projectRoot),
    unsupportedEngines,
    warnings,
    ...(postcssConfigDir ? { postcssConfigDir } : {}),
    ...(tailwind3?.configPath
      ? {
          tailwind3ConfigPath: tailwind3.configPath,
          tailwind3PostcssConfigFile: tailwind3.postcssConfigFile,
        }
      : {}),
  };
}

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
  "publicDir",
  "resolve.alias",
  "css.preprocessorOptions",
  "plugins",
];

export interface ViteConfigData {
  configFile?: string;
  publicDir?: string;
  aliases: Array<{ find: RegExp; replacement: string }>;
  ignoredKeys: string[];
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

export function VITE_CONFIG_IGNORED_WARNING(configFile: string, keys: string[]): string {
  const base =
    `${configFile} declares ${keys.join(", ")}, which the harness read but cannot honor: the project's ` +
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
  return resolved.replace(/\\/g, "/");
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

function literalPropertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  const name = property.name;
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function stringLiteralValue(node: ts.Expression): string | undefined {
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

function findViteConfigFile(dir: string): string | undefined {
  for (const name of VITE_CONFIG_FILES) {
    const candidate = path.join(dir, name);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

interface ParsedViteConfig {
  publicDir?: string;
  aliasEntries: Array<{ find: string; replacement: string }>;
  conditions: string[];
  ignored: Set<string>;
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
  const preprocessorOptions: PreprocessorOptions = {};
  const unfoldable: string[] = [];

  for (const property of config.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = literalPropertyName(property);

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
            aliasEntries.push({ find, replacement: replacement.replace(/\\/g, "/") });
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
      const empty =
        ts.isArrayLiteralExpression(property.initializer) &&
        property.initializer.elements.length === 0;
      if (!empty) ignored.add("plugins");
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
    aliasEntries,
    conditions,
    ignored,
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
      data.aliases = parsed.aliasEntries.map(toAliasRegex);
      data.conditions = parsed.conditions;
      data.ignoredKeys = IGNORED_KEY_ORDER.filter((key) => parsed!.ignored.has(key));
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
        const forwardRootConfigFile = rootConfigFile.replace(/\\/g, "/");
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

// M78 (preact-app-F3, the webpack/Next.js shape). A bare-specifier bundler
// alias ("react-dom": "preact/compat") is dropped by readViteConfigData's own
// fs.existsSync requirement above, and no reader exists at all for
// next.config/webpack.config: 120fps applies neither shape to its own mount
// (see the milestone's "Does NOT include"), so this is a disclosure gap, not
// a silent-wrong-analysis risk the way the Vite literal-alias shape is. Same
// invariant as readViteConfigData: text-parsed, never imported, never run.
const BUNDLER_CONFIG_FILES = [
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
  "next.config.ts",
  "webpack.config.js",
  "webpack.config.mjs",
  "webpack.config.cjs",
  "webpack.config.ts",
];

// Walks every node in the file, not just a recognized resolve.alias shape:
// the field-tested pattern is `Object.assign(config.resolve.alias, {...})`
// inside a `webpack:` customizer, so the react-dom key can appear inside a
// plain object literal, a call argument, or an assignment target alike.
function findReactDomPreactAlias(source: ts.SourceFile): string | undefined {
  let found: string | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAssignment(node)) {
      const name = literalPropertyName(node);
      if (name === "react-dom") {
        const value = stringLiteralValue(node.initializer);
        if (value && value.includes("preact")) {
          found = value;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function detectBundlerReactDomAlias(
  projectRoot: string,
): { configFile: string; target: string } | undefined {
  for (const name of BUNDLER_CONFIG_FILES) {
    const candidate = path.join(projectRoot, name);
    if (!isFile(candidate)) continue;
    let text: string;
    try {
      text = fs.readFileSync(candidate, "utf-8");
    } catch {
      continue;
    }
    const source = ts.createSourceFile(candidate, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const target = findReactDomPreactAlias(source);
    if (target) return { configFile: candidate, target };
  }
  return undefined;
}

export function BUNDLER_PREACT_ALIAS_WARNING(configFile: string, target: string): string {
  return (
    `${configFile} aliases react-dom to "${target}" for at least one build target 120fps cannot ` +
    "evaluate (the harness never executes your bundler config); if that alias is active in " +
    "production, this measurement runs the real react-dom, not what your app ships."
  );
}

export const ENV_DEFINE_PREFIXES = ["NEXT_PUBLIC_", "VITE_"];
const ENV_FILES = [".env", ".env.local"];
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// KEY=VALUE only: no interpolation, no export semantics, no dotenv dependency.
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = assignment.indexOf("=");
    if (separator <= 0) continue;
    const key = assignment.slice(0, separator).trim();
    if (!ENV_KEY_PATTERN.test(key)) continue;
    let value = assignment.slice(separator + 1).trim();
    const quote = value.charAt(0);
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

// Verified against the installed Vite 6.4.2: the vite:define transform returns
// early for a client environment outside a build, so config defines reach the
// page through vite/dist/client/env.mjs, which walks each dotted key and assigns
// it onto globalThis. Without one, `process` is undefined in the page and any
// `process.env.X` throws. Keys are sorted before serialization, so the bare
// object is created first and the specific keys are written into it.
// Only public prefixes are exported: a .env also holds database URLs.
export function readEnvDefines(
  memberRoot: string,
  workspaceRoot: string = findWorkspaceRoot(memberRoot),
): Record<string, string> {
  const levels =
    path.resolve(workspaceRoot) === path.resolve(memberRoot)
      ? [memberRoot]
      : [workspaceRoot, memberRoot];

  const values: Record<string, string> = {};
  for (const level of levels) {
    for (const name of ENV_FILES) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(level, name), "utf-8");
      } catch {
        continue;
      }
      Object.assign(values, parseEnvFile(text));
    }
  }

  const defines: Record<string, string> = { "process.env": "{}" };
  for (const [key, value] of Object.entries(values)) {
    if (!ENV_DEFINE_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    defines[`process.env.${key}`] = JSON.stringify(value);
  }
  return defines;
}

// M79 gap 3b: readEnvDefines reads .env/.env.local at the workspace and
// member levels and forwards only NEXT_PUBLIC_*/VITE_*-prefixed keys as Vite
// defines — process.env itself is defined as `{}`, so nothing from the
// invoking shell's own environment ever reaches the page. A fatal page error
// whose real cause is a missing env var (taxonomy-F1's env-validation throw)
// needs to know whether that remedy even applies here: this answers "does
// any env file exist at all", independent of whether it defined a
// page-visible key.
export function hasAnyEnvFile(
  memberRoot: string,
  workspaceRoot: string = findWorkspaceRoot(memberRoot),
): boolean {
  const levels =
    path.resolve(workspaceRoot) === path.resolve(memberRoot)
      ? [memberRoot]
      : [workspaceRoot, memberRoot];
  for (const level of levels) {
    for (const name of ENV_FILES) {
      if (isFile(path.join(level, name))) return true;
    }
  }
  return false;
}

export const NO_ENV_FILE_REMEDY_NOTE =
  "No .env or .env.local found: 120fps carries a working .env/.env.local injection mechanism, but " +
  `only ${ENV_DEFINE_PREFIXES.join("/")}-prefixed keys reach the page, and the invoking shell's own ` +
  "environment is never read. If this failure is a missing environment variable, add it to a .env " +
  "file at the project or workspace root.";

export const REACT_COMPILER_PACKAGE = "babel-plugin-react-compiler";

export const REACT_COMPILER_DISABLED_WARNING =
  "React Compiler is installed but disabled for this run; rerender costs will be higher than production.";

// M108 review: the plugin defaults its target to React 19 when none is passed,
// so an undetectable React major would compile against a runtime the project
// may not have, undisclosed. An undisclosable target keeps the compiler off.
export function reactCompilerTargetUnknownWarning(projectRoot: string): string {
  return (
    `the installed React version could not be read from ${projectRoot}, so the React Compiler ` +
    `target is unknown; measuring without the compiler transform.`
  );
}

export function reactCompilerResolutionWarning(projectRoot: string): string {
  return (
    `${REACT_COMPILER_PACKAGE} is declared but could not be resolved from ${projectRoot}; ` +
    `measuring without the compiler transform.`
  );
}

// Package presence is the whole signal: next.config.* can be TypeScript and can
// compute its own config, which is a large evaluation surface for one boolean.
// Declared, never merely resolvable: the compiler rewrites the code that gets
// measured, so a hoisted transitive copy must not switch it on (M27 H14). The
// workspace root counts as a declaration; a hoisted install does not.
export function detectReactCompiler(projectRoot: string): boolean {
  return isPackageDeclared(REACT_COMPILER_PACKAGE, projectRoot);
}

// Walking up from the resolved entry reaches the package's own manifest in any
// layout; the package.json subpath does not, because an exports map may hide it.
function readCompilerVersion(pluginPath: string): string | undefined {
  let dir = path.dirname(pluginPath);
  while (true) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(manifest, "utf-8"));
        if (pkg?.name !== REACT_COMPILER_PACKAGE) return undefined;
        return typeof pkg.version === "string" ? pkg.version : undefined;
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface ReactCompilerResolution {
  pluginPath?: string;
  version?: string;
}

// Resolved from the project so the compiler version matches what it ships.
export function resolveReactCompiler(projectRoot: string): ReactCompilerResolution {
  try {
    const projectRequire = createRequire(path.join(projectRoot, "/"));
    const pluginPath = projectRequire.resolve(REACT_COMPILER_PACKAGE);
    const version = readCompilerVersion(pluginPath);
    return { pluginPath, ...(version ? { version } : {}) };
  } catch {
    return {};
  }
}

export interface ReactCompilerState {
  detected: boolean;
  active: boolean;
  version?: string;
  pluginPath?: string;
  warning?: string;
  // M108 A3/A4: the React major the transform compiles for, and why it did not
  // run when the runtime that major needs is absent.
  target?: ReactCompilerTarget;
  skipped?: { target: string; missingModule: string };
}

// At most one warning per state, so the disabled note and the resolution note
// can never both reach the report.
export function resolveReactCompilerState(
  projectRoot: string,
  requested: boolean | undefined,
): ReactCompilerState {
  const detected = detectReactCompiler(projectRoot);

  if (requested === false) {
    return {
      detected,
      active: false,
      ...(detected ? { warning: REACT_COMPILER_DISABLED_WARNING } : {}),
    };
  }
  if (requested === undefined && !detected) return { detected: false, active: false };

  const { pluginPath, version } = resolveReactCompiler(projectRoot);
  if (!pluginPath) {
    if (requested === true) {
      throw new Error(
        `${REACT_COMPILER_PACKAGE} not found in ${projectRoot}; install ${REACT_COMPILER_PACKAGE} ` +
          `in the project, or drop --react-compiler.`,
      );
    }
    return {
      detected,
      active: false,
      warning: reactCompilerResolutionWarning(projectRoot),
    };
  }
  const installedTarget = detectReactMajor(projectRoot);
  // A react that IS installed answers for the major by itself: an unreadable or
  // pre-17 install is an unknown target, never the declared range's answer.
  const target =
    installedTarget ??
    (installedPackageDir("react", projectRoot) ? undefined : declaredReactMajor(projectRoot));
  if (!target) {
    return {
      detected,
      active: false,
      ...(version ? { version } : {}),
      warning: reactCompilerTargetUnknownWarning(projectRoot),
    };
  }
  const runtime = reactCompilerRuntime(target);
  // The runtime probe reads what is installed, so it only speaks when react
  // itself is installed; a declared-only target has nothing to probe.
  if (installedTarget && reactCompilerRuntimeDeps(projectRoot, target).length === 0) {
    return {
      detected,
      active: false,
      ...(version ? { version } : {}),
      target,
      skipped: { target, missingModule: runtime.module },
      warning: reactCompilerRuntimeMissingWarning(target, runtime.module, runtime.package),
    };
  }
  return {
    detected,
    active: true,
    pluginPath,
    ...(version ? { version } : {}),
    ...(target ? { target } : {}),
  };
}

// Compiled output imports react/compiler-runtime. @vitejs/plugin-react only
// pre-bundles that module when it recognises the babel plugin by its bare name,
// and K2 requires the project-resolved absolute path, so the import has to be
// declared here: otherwise Vite discovers it on the first page load and forces
// a full reload that destroys the execution context mid-measurement. React 18
// projects have no such module; there the entry is skipped.
export function reactCompilerRuntimeDeps(
  projectRoot: string,
  target: ReactCompilerTarget = "19",
): string[] {
  const runtime = reactCompilerRuntime(target);
  try {
    createRequire(path.join(projectRoot, "/")).resolve(runtime.module);
    return [runtime.module];
  } catch {
    return [];
  }
}

// M108 A3 (primer-react-F1): the compiler emits the runtime import its target
// names, so the target has to be the React the project installs. React 19
// ships the runtime inside react itself; 17 and 18 take it from the separate
// react-compiler-runtime package the project installs beside them.
export type ReactCompilerTarget = "17" | "18" | "19";

export function detectReactMajor(projectRoot: string): ReactCompilerTarget | undefined {
  const reactDir = installedPackageDir("react", projectRoot);
  if (!reactDir) return undefined;
  return majorOf(readProjectManifest(reactDir)?.version);
}

// With no react installed the declared range is the only evidence of the major
// there is. An install that reads always wins over it.
function declaredReactMajor(projectRoot: string): ReactCompilerTarget | undefined {
  const manifest = readProjectManifest(projectRoot) as
    | {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
        peerDependencies?: Record<string, unknown>;
      }
    | undefined;
  return majorOf(
    manifest?.dependencies?.react ??
      manifest?.devDependencies?.react ??
      manifest?.peerDependencies?.react,
  );
}

function majorOf(version: unknown): ReactCompilerTarget | undefined {
  if (typeof version !== "string") return undefined;
  const major = /^\D*(\d+)/.exec(version)?.[1];
  if (major === "17" || major === "18") return major;
  return Number(major) >= 19 ? "19" : undefined;
}

export function reactCompilerRuntime(target: ReactCompilerTarget): {
  module: string;
  package: string;
} {
  return target === "19"
    ? { module: "react/compiler-runtime", package: "react" }
    : { module: "react-compiler-runtime", package: "react-compiler-runtime" };
}

// M92: an option the plugin defaults for us is an option this run cannot
// disclose, so the target is always passed explicitly once it is known.
export function reactCompilerBabelOptions(
  target: ReactCompilerTarget | undefined,
): Record<string, string> {
  return target ? { target } : {};
}

export function reactCompilerRuntimeMissingWarning(
  target: ReactCompilerTarget,
  module: string,
  supplier: string,
): string {
  return (
    `${REACT_COMPILER_PACKAGE} runs at target ${target} here (the React this project installs), ` +
    `whose runtime import "${module}" ` +
    `does not resolve from this project (${supplier} supplies it); skipping the compiler ` +
    "transform and measuring without it."
  );
}

// Vite transforms the generated .tsx entry with the automatic JSX runtime, so
// the page imports react/jsx-dev-runtime even though nothing declares it. Left
// undeclared, Vite discovers it on the first page load of a project whose
// optimizer cache is cold, pre-bundles it, and full-reloads: destroying the
// execution context mid-measurement. Resolved from the project: React 16 has no
// automatic runtime, and an unresolvable include aborts server start.
export function reactJsxRuntimeDeps(projectRoot: string): string[] {
  const projectRequire = createRequire(path.join(projectRoot, "/"));
  const deps: string[] = [];
  for (const dep of ["react/jsx-runtime", "react/jsx-dev-runtime"]) {
    try {
      projectRequire.resolve(dep);
      deps.push(dep);
    } catch {
      // Not available in this React version.
    }
  }
  return deps;
}

// Imported on demand: a run without the compiler never loads @babel/core.
export async function loadReactCompilerPlugin(
  pluginPath: string,
  target?: ReactCompilerTarget,
): Promise<unknown[]> {
  const mod = await import("@vitejs/plugin-react");
  const factory = (mod as { default?: unknown }).default ?? mod;
  if (typeof factory !== "function") {
    throw new Error("@vitejs/plugin-react has no callable default export");
  }
  const plugin = (factory as (options: unknown) => unknown)({
    babel: { plugins: [[pluginPath, reactCompilerBabelOptions(target)]] },
  });
  return Array.isArray(plugin) ? plugin : [plugin];
}

// M48. A curated passthrough, not `vite.config` wholesale: each entry is an
// explicit integration resolved from the *project's* node_modules, following
// the M27 React Compiler pattern.
//
// The support list is evidence-driven. `probeCandidates` are the ones the M48
// spike verified end to end against a real project; anything else stays a
// recognizer-only diagnosis until a spike proves it loads.
export interface TransformPlugin {
  // Matches a `TRANSFORM_RECOGNIZERS` code, so a diagnosis and a fix share a name.
  code: string;
  packageName: string;
  // The named export carrying the factory, for packages that have no default.
  exportName?: string;
  // Some plugins need options to behave outside their normal dev-server context.
  options?: unknown;
}

export const SUPPORTED_TRANSFORM_PLUGINS: TransformPlugin[] = [
  { code: "svgr", packageName: "vite-plugin-svgr" },
  {
    code: "vanilla-extract",
    packageName: "@vanilla-extract/vite-plugin",
    exportName: "vanillaExtractPlugin",
  },
  // M57. Without it nothing mounts a `.vue` file at all, so this is the one
  // entry on the list a whole framework depends on. A project with `.vue` files
  // and no plugin keeps the M48 recognizer warning.
  { code: "vue", packageName: "@vitejs/plugin-vue" },
];

// Three shapes in the wild, all seen in the M48 spike: a real default export, a
// CJS package double-wrapped by interop (`mod.default.default`), and a package
// whose factory is only a named export.
export function resolvePluginFactory(
  mod: unknown,
  exportName?: string,
): ((options?: unknown) => unknown) | undefined {
  const namespace = mod as Record<string, unknown>;
  const candidates: unknown[] = [];
  if (exportName) candidates.push(namespace?.[exportName]);
  candidates.push(namespace?.default);
  const asDefault = namespace?.default as Record<string, unknown> | undefined;
  candidates.push(asDefault?.default);
  if (exportName) candidates.push(asDefault?.[exportName]);
  candidates.push(mod);
  return candidates.find((c) => typeof c === "function") as
    | ((options?: unknown) => unknown)
    | undefined;
}

// M83 #8 (primevue-Probe1): resolution via the hoisted-transitive-copy
// fallback (isInstalledOnResolutionChain, inside isPackageAvailable) is
// correct and by design per M75 — only the disclosure was missing. A plugin
// found only that way, not declared in this project's own package.json, gets
// named so a stricter installer (no hoisting) is not a surprise later.
export function detectProjectTransforms(
  projectRoot: string,
  workspaceRoot: string = findWorkspaceRoot(projectRoot),
  onWarning?: (warning: string) => void,
): TransformPlugin[] {
  const matched = SUPPORTED_TRANSFORM_PLUGINS.filter((entry) =>
    isPackageAvailable(entry.packageName, projectRoot, workspaceRoot),
  );
  for (const entry of matched) {
    if (!isPackageDeclared(entry.packageName, projectRoot, workspaceRoot)) {
      onWarning?.(HOISTED_TRANSFORM_WARNING(entry.packageName));
    }
  }
  return matched;
}

export const HOISTED_TRANSFORM_WARNING = (packageName: string): string =>
  `${packageName} was found via a hoisted transitive install, not declared in this project's own ` +
  "package.json; a stricter installer (no hoisting) would not resolve it.";

// Server and HMR hooks are stripped: the harness owns the server's lifecycle,
// and a project plugin reaching into it is the class of failure M30 documented.
// Build-time hooks: resolve/load/transform: are the whole point.
const STRIPPED_PLUGIN_HOOKS = [
  "configureServer",
  "configurePreviewServer",
  "handleHotUpdate",
  "hotUpdate",
];

export function stripServerHooks(plugin: unknown): unknown {
  if (!plugin || typeof plugin !== "object") return plugin;
  const copy: Record<string, unknown> = { ...(plugin as Record<string, unknown>) };
  for (const hook of STRIPPED_PLUGIN_HOOKS) delete copy[hook];
  return copy;
}

export const TRANSFORM_LOAD_FAILED_WARNING = (code: string, detail: string): string =>
  `[transform:${code}] the project's plugin could not be loaded, so imports it owns will not ` +
  `compile: ${detail}. The run continues without it.`;

export async function loadProjectTransformPlugins(
  projectRoot: string,
  entries: TransformPlugin[],
  onWarning?: (warning: string) => void,
): Promise<unknown[]> {
  const loaded: unknown[] = [];
  for (const entry of entries) {
    try {
      const projectRequire = createRequire(path.join(projectRoot, "/"));
      const resolved = projectRequire.resolve(entry.packageName);
      const mod = await import(pathToFileURL(resolved).href);
      const factory = resolvePluginFactory(mod, entry.exportName);
      if (!factory) {
        throw new Error(`${entry.packageName} exposes no callable plugin factory`);
      }
      const produced = factory(entry.options);
      const list = Array.isArray(produced) ? produced : [produced];
      loaded.push(...list.map(stripServerHooks));
    } catch (err) {
      // Never fatal: a component that does not touch this transform still
      // measures, and one that does gets M48's recognizer diagnosis anyway.
      onWarning?.(TRANSFORM_LOAD_FAILED_WARNING(entry.code, err instanceof Error ? err.message : String(err)));
    }
  }
  return loaded;
}

// Probe order is significant: first hit wins (W1).
export const WRAPPER_CANDIDATES = [
  "120fps.setup.tsx",
  "120fps.setup.jsx",
  "120fps.setup.ts",
  "120fps.setup.js",
  "120fps.setup.vue",
];

// A `.tsx` wrapper in a Vue project cannot render a Vue component, so the SFC
// is probed first there: otherwise a stray leftover file would silently break
// the run it was supposed to fix.
export function detectWrapper(projectRoot: string, framework?: string): string | undefined {
  const candidates =
    framework === "vue"
      ? ["120fps.setup.vue", ...WRAPPER_CANDIDATES.filter((c) => c !== "120fps.setup.vue")]
      : WRAPPER_CANDIDATES;
  for (const name of candidates) {
    const candidate = path.join(projectRoot, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // missing or unreadable: try the next candidate
    }
  }
  return undefined;
}

// Static approximation of "default export is a React component": we can only
// rule out the cases that are provably not callable. The wrapper may import
// CSS and browser-only packages, so it cannot be evaluated in Node.
function hasCallableDefaultExport(sourceText: string, fileName: string): boolean {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, false);
  let found = false;

  ts.forEachChild(sourceFile, (node) => {
    if (found) return;

    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const expr = node.expression;
      const notCallable =
        ts.isObjectLiteralExpression(expr) ||
        ts.isArrayLiteralExpression(expr) ||
        ts.isNumericLiteral(expr) ||
        ts.isStringLiteral(expr) ||
        ts.isNoSubstitutionTemplateLiteral(expr) ||
        expr.kind === ts.SyntaxKind.TrueKeyword ||
        expr.kind === ts.SyntaxKind.FalseKeyword ||
        expr.kind === ts.SyntaxKind.NullKeyword;
      if (!notCallable) found = true;
      return;
    }

    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      found = true;
      return;
    }

    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const spec of node.exportClause.elements) {
        if (!spec.isTypeOnly && spec.name.text === "default") found = true;
      }
    }
  });

  return found;
}

// @vitejs/plugin-vue emits `import _sfc_main from "<sfc>?vue&type=script"`
// whenever an SFC has any <script> block, so a block that produces no default
// export fails module evaluation in the browser: the Vue analogue of the
// missing-default-export wrapper M26 fixed for React. An SFC with no <script>
// at all is fine: the plugin synthesizes an empty component for it.
//
// An empty `<script setup>` counts as absent to the compiler, which is the
// shape that looks most correct and fails hardest.
export function sfcProducesComponent(
  source: string,
  fileName: string,
  compiler: VueSfcCompiler,
): boolean {
  let descriptor;
  try {
    descriptor = compiler.parse(source, { filename: fileName }).descriptor;
  } catch {
    // A malformed SFC is the plugin's error to report, with real positions.
    return true;
  }
  const setup = descriptor?.scriptSetup;
  const script = descriptor?.script;
  if (!setup && !script) return true;
  if (setup && setup.content.trim().length > 0) return true;
  if (script && hasAnyDefaultExport(script.content, `${fileName}.ts`)) return true;
  return false;
}

// Vue's Options API default-exports a plain object, which
// `hasCallableDefaultExport` deliberately rejects for React. Here the question
// is only whether the module has a default export at all: the plugin imports
// it either way, and an object is a perfectly good Vue component.
function hasAnyDefaultExport(sourceText: string, fileName: string): boolean {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, false);
  let found = false;

  ts.forEachChild(sourceFile, (node) => {
    if (found) return;
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      found = true;
      return;
    }
    if (
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      found = true;
      return;
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const spec of node.exportClause.elements) {
        if (!spec.isTypeOnly && spec.name.text === "default") found = true;
      }
    }
  });

  return found;
}

export const SFC_NO_COMPONENT = (relative: string): string =>
  `${relative} has a <script> block that exports no component, so nothing can be mounted from it. ` +
  "Add `export default` to that block, or move the code into a non-empty <script setup> " +
  "(an empty <script setup> counts as absent to the Vue compiler).";

export function resolveWrapper(wrapPath: string, projectRoot: string): string {
  const absolute = path.resolve(wrapPath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Wrapper module not found: ${wrapPath}`);
  }
  const relative = path.relative(projectRoot, absolute).replace(/\\/g, "/");
  // M73: the raw relative path decides, not its forward-slashed form: a wrapper
  // on another Windows drive has an absolute relative form and no "../" prefix.
  if (isOutsideRoot(absolute, projectRoot)) {
    throw new Error(
      `Wrapper module ${wrapPath} must live inside the project root ${projectRoot}`,
    );
  }
  const source = fs.readFileSync(absolute, "utf-8");
  if (isVueFile(absolute)) {
    // An SFC's component is its default export by construction; the only thing
    // provable here is that the file is an SFC at all.
    if (!/<template[\s>]|<script[\s>]/.test(source)) {
      throw new Error(
        `Wrapper module ${wrapPath} must be a Vue single-file component rendering its default slot`,
      );
    }
    return relative;
  }
  if (!hasCallableDefaultExport(source, absolute)) {
    throw new Error(
      `Wrapper module ${wrapPath} must default-export a React component taking { children }`,
    );
  }
  return relative;
}

// M77: Vite's own esbuild transform plugin (`vite:esbuild`) applies ONE
// loader to every file its filter matches; its default filter excludes plain
// `.js`, so a `.js` file with literal JSX (MUI's own authoring convention)
// fails Vite's transform even once the CLI gate accepts it. Widening that
// filter and forcing `loader: "jsx"` was considered and rejected: the loader
// is shared by every matched file, so a widened filter also routes typed
// `.ts`/`.tsx` files through the "jsx" loader, and esbuild's "jsx" loader
// rejects TypeScript-only syntax outright (verified against the installed
// esbuild: `transformSync("interface X{}", { loader: "jsx" })` throws). This
// standalone plugin, run ahead of Vite's own (`enforce: "pre"`), instead
// transforms only `.js` outside `node_modules` with esbuild's "jsx" loader
// directly; by the time Vite's own `vite:esbuild` plugin looks at the file,
// its default filter already excludes `.js`, so nothing there re-transforms
// it. Vendored `.js` under node_modules, and every `.ts`/`.tsx` file, never
// reach this plugin at all.
export const DEFAULT_JSX_IMPORT_SOURCE = "react";

//
// M97 (I1, material-ui-F2): the loader alone is not the whole transform.
// Vite's `transformWithEsbuild` reads the project tsconfig's JSX settings only
// for the "ts"/"tsx" loaders (vite 6.4.2, dep chunk :9086), so `loader: "jsx"`
// left `compilerOptions.jsx` undefined and esbuild fell back to its classic
// `React.createElement` transform. A `.js` authored for the automatic runtime
// (`"jsx": "react-jsx"`, no `React` binding of its own — MUI's
// `internal/svg-icons/*.js`) then threw `React is not defined` the instant the
// module evaluated. The runtime is passed explicitly: automatic, with the
// project's own `jsxImportSource` when its tsconfig sets one. Automatic also
// compiles a file that does import React, so one setting covers both forms.
export function jsxInJsPlugin(jsxImportSource: string = DEFAULT_JSX_IMPORT_SOURCE): {
  name: string;
  enforce: "pre";
  transform(code: string, id: string): Promise<{ code: string; map: unknown } | null>;
} {
  return {
    name: "120fps-jsx-in-js",
    enforce: "pre",
    async transform(code, id) {
      const file = id.split("?")[0];
      if (!file.endsWith(".js")) return null;
      if (/[\\/]node_modules[\\/]/.test(file)) return null;
      const result = await transformWithEsbuild(code, id, {
        loader: "jsx",
        jsx: "automatic",
        jsxImportSource,
      });
      return { code: result.code, map: result.map };
    },
  };
}

// The runtime package whose `/jsx-runtime` the automatic transform imports.
// Read from the config that governs the project (the same
// `findCompilerConfig` walk alias construction and prop extraction use), so a
// preact project's `"jsxImportSource": "preact"` is honoured instead of
// hard-coding React. Any read/parse failure falls back to React rather than
// failing the run: the previous behaviour compiled these files at all.
export function resolveJsxImportSource(
  projectRoot: string,
  workspaceRoot: string = findWorkspaceRoot(projectRoot),
  forFile?: string,
): string {
  try {
    // M109 (I1): the governing config, so a references-only root reaches the
    // referenced config that declares jsxImportSource. The file decides which
    // referenced config that is: a directory query matches whichever config
    // covers any file under the root, which is the first `references` entry,
    // not the one covering the component being measured.
    const declared = resolveGoverningTsconfig(
      forFile ?? projectRoot,
      workspaceRoot,
    ).options.jsxImportSource;
    return declared && declared.length > 0 ? declared : DEFAULT_JSX_IMPORT_SOURCE;
  } catch {
    return DEFAULT_JSX_IMPORT_SOURCE;
  }
}

// M109 (A3, ark-F1): with no esbuild option of its own, vite:esbuild reads the
// project tsconfig for the ts/tsx loaders, so ark's `"jsx": "preserve"` (the
// standard Vite library setup, where the project's own plugin-react supplies
// the runtime the harness does not run) fell through to esbuild's classic
// React.createElement transform. ark imports only named React exports, so the
// first JSX evaluation threw `React is not defined` and every .tsx in the
// repository was mis-transformed. These are the two settings jsxInJsPlugin has
// applied to project .js files since M77.
export function harnessEsbuildOptions(
  projectRoot: string,
  workspaceRoot?: string,
  forFile?: string,
): { jsx: "automatic"; jsxImportSource: string } {
  return {
    jsx: "automatic",
    jsxImportSource: resolveJsxImportSource(
      projectRoot,
      workspaceRoot ?? findWorkspaceRoot(projectRoot),
      forFile,
    ),
  };
}

// The two compile-shaping keys createServer receives, in one place a test can
// hold: a Vue project keeps the vue plugin's own compilation of its SFC blocks
// and receives no esbuild key at all.
export function harnessServerCompileOptions(
  renderer: string,
  projectRoot: string,
  workspaceRoot: string,
  componentPath: string,
  resolveConditions: string[],
): {
  esbuild?: { jsx: "automatic"; jsxImportSource: string };
  conditions?: string[];
} {
  return {
    ...(renderer === "vue"
      ? {}
      : { esbuild: harnessEsbuildOptions(projectRoot, workspaceRoot, componentPath) }),
    ...(resolveConditions.length > 0 ? { conditions: resolveConditions } : {}),
  };
}

export function RESOLVE_CONDITIONS_WARNING(
  conditions: string[],
  tsconfigPath: string,
  viteConfigFile?: string,
): string {
  const source = viteConfigFile
    ? `${path.basename(viteConfigFile)}'s resolve.conditions and customConditions in ${tsconfigPath}`
    : `customConditions in ${tsconfigPath}`;
  return `resolve.conditions [${conditions.join(", ")}] came from ${source}.`;
}

// M109 (A5, react-spectrum-F2): react-aria publishes its subpaths only under
// the `source` condition the consuming tsconfig declares, with no dist/ to fall
// back to, and the dev server answered 500 for every one of them; nothing here
// ever read customConditions. The vite config's own list stays first, so every
// export a project already resolved resolves the same way.
export function resolveServerConditions(
  projectRoot: string,
  viteConditions: string[],
  opts?: { forFile?: string; workspaceRoot?: string; viteConfigFile?: string },
): { conditions: string[]; warning?: string } {
  const governing = resolveGoverningTsconfig(
    opts?.forFile ?? projectRoot,
    opts?.workspaceRoot ?? findWorkspaceRoot(projectRoot),
  );
  const declared = governing.options.customConditions ?? [];
  const added = declared.filter((condition) => !viteConditions.includes(condition));
  const conditions = [...viteConditions, ...added];
  if (added.length === 0 || !governing.configPath) return { conditions };
  return {
    conditions,
    warning: RESOLVE_CONDITIONS_WARNING(
      conditions,
      governing.configPath,
      viteConditions.length > 0 ? opts?.viteConfigFile : undefined,
    ),
  };
}

const RESOLVE_ENTRY_FAILURE = /Failed to resolve entry for package "([^"]+)"/;

// Vite/esbuild's own manifest fields to probe, in the order Node's own
// exports resolution would prefer them for a "." conditional export.
function resolveManifestEntry(manifest: Record<string, unknown>): string | undefined {
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
  return path.resolve(import.meta.dirname ?? __dirname, "..").replace(/\\/g, "/");
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
// continued unstyled instead -- the governing policy (specs/milestones/
// m95-*.md): skip unresolvable build artifacts and measure anyway wherever
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

// M96 (calcom-F2, deferred here by Lane C's spec: the failure happens at
// esbuild's static ES-module resolution layer, before any shim code runs, so
// only this bundler-error layer can catch and re-present it). esbuild's own
// "No matching export" message names the shim's absolute dist/shims path --
// a path inside 120fps's own installation, which M94's own MUST NOT already
// forbids printing. Recognized by exact match against the shim file this
// same process would have aliased to (buildShimAliases' own shimDir
// computation), not by a loose basename guess, so an unrelated file in the
// target repo that happens to share a shim's filename is never misattributed.
const ESBUILD_NO_MATCHING_EXPORT = /No matching export in "([^"]+)" for import "([^"]+)"/;

export function SHIM_EXPORT_MISSING_ERROR(shimModule: string, missingExport: string): string {
  return (
    `"${missingExport}" is not available from 120fps's own "${shimModule}" shim. Pass --no-shims ` +
    "to fall back to the project's real module instead (if it resolves standalone), or report " +
    "this shim gap."
  );
}

function diagnoseMissingShimExport(message: string): string | undefined {
  const match = ESBUILD_NO_MATCHING_EXPORT.exec(message);
  if (!match) return undefined;
  const filePath = match[1].replace(/\\/g, "/");
  const missingExport = match[2];
  const shimDir = path.resolve(import.meta.dirname ?? __dirname, "shims").replace(/\\/g, "/");
  const entry = SHIM_MODULES.find((s) => `${shimDir}/${s.shimFile}` === filePath);
  if (!entry) return undefined;
  return SHIM_EXPORT_MISSING_ERROR(entry.module, missingExport);
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

function findGitRootUpward(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
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
  const gitRoot = findGitRootUpward(importerDir);
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


// The pre-build half of `buildAndServe`, in call order, with nothing that
// starts a process: `loadTsconfigAliases`, `readViteConfigData` (text-parsed,
// never imported), `scanExternalDeps` (path probes), the Next shim inventory
// and `resolveStyleTooling` (dependency probes). Warnings come back in exactly
// the order `buildAndServe` produced them, and no message is reworded.
export function collectStaticPreBuildWarnings(
  projectRoot: string,
  opts: {
    componentPath: string;
    wrapPath?: string;
    noShims?: boolean;
    workspaceRoot?: string;
  },
): StaticPreBuild {
  const workspaceRoot = opts.workspaceRoot ?? findWorkspaceRoot(projectRoot);
  // M69: alias construction and the scan both report what they could not
  // resolve, and both feed the same run warnings.
  const warnings: string[] = [];
  const tsconfigAliases = loadTsconfigAliases(projectRoot, warnings, opts.componentPath);
  const detected = !opts.noShims && detectNextJs(projectRoot);
  const shimAliases = buildShimAliases(detected);
  // M71: what the project's own vite.config says, read as text. Its aliases sit
  // below the tsconfig paths, which is the precedence a TypeScript project
  // already assumes, and above the shims, which answer for one module each.
  const viteConfig = readViteConfigData(projectRoot, workspaceRoot);
  if (viteConfig.configFile && viteConfig.ignoredKeys.length > 0) {
    warnings.push(
      VITE_CONFIG_IGNORED_WARNING(path.basename(viteConfig.configFile), viteConfig.ignoredKeys),
    );
  }
  warnings.push(...viteConfig.warnings);
  // M109 (A5): decided here, so the dry run discloses the list the real run
  // resolves with.
  const serverConditions = resolveServerConditions(projectRoot, viteConfig.conditions, {
    forFile: opts.componentPath,
    workspaceRoot,
    ...(viteConfig.configFile ? { viteConfigFile: viteConfig.configFile } : {}),
  });
  if (serverConditions.warning) warnings.push(serverConditions.warning);
  const aliases: StaticPreBuild["aliases"] = [
    ...tsconfigAliases,
    ...viteConfig.aliases,
    ...shimAliases,
  ];

  // The wrapper is imported by the entry, so its packages must be pre-bundled
  // too: otherwise the first mount pays Vite's on-demand optimize cost.
  const importedSpecifiers = new Set<string>();
  // M110 (A2/I2): filled by the same walk that produces the include list, so
  // the dry run reports what the real run's optimizer would have choked on.
  const unresolvedExternals: Array<{ specifier: string; importer: string }> = [];
  const externalDeps = [
    ...new Set([
      ...scanExternalDeps(
        path.resolve(opts.componentPath),
        projectRoot,
        aliases,
        importedSpecifiers,
        warnings,
        workspaceRoot,
        aliases,
        unresolvedExternals,
      ),
      ...(opts.wrapPath
        ? scanExternalDeps(
            path.resolve(opts.wrapPath),
            projectRoot,
            aliases,
            importedSpecifiers,
            warnings,
            workspaceRoot,
            aliases,
            unresolvedExternals,
          )
        : []),
    ]),
  ];

  // Shims are keyed by module specifier ("next/image"), which scanExternalDeps
  // collapses to a package name ("next") for optimizeDeps: match on the raw
  // specifiers instead.
  let activeShims: string[] | undefined;
  let unsupported: string[] = [];
  if (detected) {
    const shimmed = SHIM_MODULES.filter((s) => importedSpecifiers.has(s.module)).map(
      (s) => s.module,
    );
    activeShims = shimmed.length > 0 ? shimmed : undefined;
    unsupported = unshimmedNextModules(importedSpecifiers);
    if (unsupported.length > 0) warnings.push(UNSUPPORTED_NEXT_MODULE_WARNING(unsupported));
  }

  // M71: the Tailwind plugin is decided by the project's dependency alone. A
  // component using utility classes needs it whether or not a global stylesheet
  // was found, and the styling engines nothing here can replicate say so once.
  const styleTooling = resolveStyleTooling(projectRoot, workspaceRoot, externalDeps);
  warnings.push(...styleTooling.warnings);

  return {
    warnings,
    viteConfig,
    resolveConditions: serverConditions.conditions,
    externalDeps,
    styleTooling,
    nextModules: { detected, ...(activeShims ? { activeShims } : {}), unsupported },
    aliases,
    importedSpecifiers,
    unresolvedExternals,
    workspaceRoot,
  };
}

export async function buildAndServe(
  componentPath: string,
  options?: BuildHarnessOptions,
): Promise<HarnessResult> {
  const absoluteComponentPath = path.resolve(componentPath);
  if (!fs.existsSync(absoluteComponentPath)) {
    throw new Error(`Component file not found: ${componentPath}`);
  }

  const componentDir = path.dirname(absoluteComponentPath);
  const projectRoot = findProjectRoot(componentDir) ?? componentDir;

  // Validate before creating the harness dir so a rejected wrapper or an
  // unresolvable forced compiler leaves nothing behind
  const wrapRelative = options?.wrapPath
    ? resolveWrapper(options.wrapPath, projectRoot)
    : undefined;
  const reactCompiler = resolveReactCompilerState(projectRoot, options?.reactCompiler);
  // Only the resolution failure is a surprise worth printing; the disabled note
  // is a consequence of the user's own flag and travels in the report.
  if (options?.reactCompiler !== false && reactCompiler.warning) {
    process.stderr.write(`Warning: ${reactCompiler.warning}\n`);
  }

  // M57: an SFC that compiles to no component would otherwise surface as a 30s
  // readiness timeout with a module-resolution message attached, naming the
  // harness instead of the file to fix. Checked here so nothing is left behind.
  const renderer = rendererFor(absoluteComponentPath);
  // M87: computed once, ahead of entry generation, so a bare (non-composed)
  // Vue mount can wrap its render only when the template root is safe to
  // force non-zero -- see templateHasUnconditionalRoot.
  let vueUnconditionalRoot = false;
  if (renderer === "vue") {
    const compiler = await loadVueCompiler(projectRoot);
    if (compiler) {
      const sfcs = [
        absoluteComponentPath,
        ...(options?.wrapPath ? [path.resolve(options.wrapPath)] : []),
      ];
      for (const sfc of sfcs) {
        if (!isVueFile(sfc)) continue;
        if (!sfcProducesComponent(fs.readFileSync(sfc, "utf-8"), sfc, compiler)) {
          throw new Error(SFC_NO_COMPONENT(path.relative(projectRoot, sfc).replace(/\\/g, "/")));
        }
      }
      if (isVueFile(absoluteComponentPath)) {
        vueUnconditionalRoot = templateHasUnconditionalRoot(
          fs.readFileSync(absoluteComponentPath, "utf-8"),
          absoluteComponentPath,
          compiler,
        );
      }
    }
  }

  // M73: react-dom/client is forced into optimizeDeps.include below, and an
  // unresolvable include aborts Vite's optimizer with an esbuild path dump.
  if (renderer === "react") {
    // I2: the Vue-project question first — otherwise a Vue `.tsx` fails as a
    // missing react-dom install, which is not why it cannot be measured.
    assertRendererSupported(absoluteComponentPath, projectRoot);
    assertReactDomClient(projectRoot);
  }

  // Crash leftovers from previous runs: best-effort removal (M24 D8)
  const sweepWarnings: string[] = [];
  sweepStaleHarnessDirs(projectRoot, sweepWarnings);

  // Place harness files inside the target project so Vite resolves aliases
  // (createHarnessDir adds it to activeHarnessDirs itself).
  const harnessDir = createHarnessDir(projectRoot);
  const harnessDirName = path.basename(harnessDir);

  const componentRelative = componentImportPath(absoluteComponentPath, projectRoot);

  const cssFiles = [...new Set((options?.cssFiles ?? []).map((f) => path.resolve(f)))];
  const cssImports = cssFiles.map((f) => cssImportSpecifier(f, projectRoot));

  const presetRelative = options?.presetPath
    ? path.relative(projectRoot, path.resolve(options.presetPath)).replace(/\\/g, "/")
    : undefined;

  let entryTsx: string;
  let component: ComponentIdentity;

  if (options?.composition) {
    entryTsx = generateComposedEntry(
      componentRelative,
      options.composition,
      options.exports,
      wrapRelative,
      cssImports,
    );
    const root = options.composition.root;
    component = {
      relative: componentRelative,
      name: root,
      isDefaultExport: options.exports?.some((e) => e.name === root && e.isDefault) ?? false,
    };
  } else {
    const { name: componentName, isDefaultOnly } = detectComponentExport(
      absoluteComponentPath,
      options?.target,
    );
    component = {
      relative: componentRelative,
      name: componentName,
      isDefaultExport: isDefaultOnly,
    };
    entryTsx = generateEntry({
      componentRelative,
      componentName,
      isDefaultExport: isDefaultOnly,
      hasScale: detectScaleExport(absoluteComponentPath),
      wrapRelative,
      cssImports,
      renderer,
      ...(presetRelative ? { presetRelative } : {}),
      ...(renderer === "vue" ? { vueUnconditionalRoot } : {}),
    });
  }

  // The Vue entry has no JSX, so it is a .ts file: and index.html has to name
  // whichever one was written.
  const entryFile = renderer === "vue" ? "entry.ts" : "entry.tsx";
  const indexHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>120fps harness</title></head>
<body><div id="root"></div><script type="module" src="./${entryFile}"></script></body>
</html>`;

  fs.writeFileSync(path.join(harnessDir, entryFile), entryTsx);
  fs.writeFileSync(path.join(harnessDir, "index.html"), indexHtml);

  // M100 (I5): the single computation of every pre-build fact this run needs.
  // `explainProps` calls the same function for a dry run (M100 records the
  // decision to keep one computation per invocation rather than hand one
  // across), so both paths produce the same warnings in the same order.
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  const preBuild = collectStaticPreBuildWarnings(projectRoot, {
    componentPath: absoluteComponentPath,
    ...(options?.wrapPath ? { wrapPath: options.wrapPath } : {}),
    ...(options?.noShims ? { noShims: true } : {}),
    workspaceRoot,
  });
  const configWarnings: string[] = [...preBuild.warnings];
  const { viteConfig, externalDeps, styleTooling } = preBuild;
  const alias = preBuild.aliases;
  const activeShims = preBuild.nextModules.activeShims;

  // A Vue project has no react to pre-bundle, and an unresolvable include
  // aborts server start: so the renderer decides the base list, not a union.
  const rendererDeps =
    renderer === "vue"
      ? ["vue"]
      : [
          "react",
          "react-dom/client",
          ...reactJsxRuntimeDeps(projectRoot),
          ...(reactCompiler.active
            ? reactCompilerRuntimeDeps(projectRoot, reactCompiler.target ?? "19")
            : []),
        ];

  const stableInclude = unionCachedDeps(
    [...rendererDeps, ...externalDeps],
    readDepCacheMetadata(projectRoot),
  );

  const plugins: unknown[] = styleTooling.tailwind
    ? await loadTailwindVitePlugin(projectRoot)
    : [];
  // M111 A1 (midday-F1): Tailwind 3 enters through PostCSS and resolves its own
  // config against `process.cwd()`, so the shell directory decided whether the
  // member's CSS built at all. Rebuilding the member's declared pipeline with
  // the config path resolved from the member takes that decision away from the
  // shell without replacing a single plugin the member declared.
  const tailwind3Postcss =
    styleTooling.tailwind3ConfigPath && styleTooling.tailwind3PostcssConfigFile
      ? await loadTailwind3PostcssPipeline(
          projectRoot,
          styleTooling.tailwind3PostcssConfigFile,
          styleTooling.tailwind3ConfigPath,
          harnessDir,
          (warning) => configWarnings.push(warning),
        )
      : undefined;
  // M77: unconditional and cheap (a no-op for every file outside a
  // non-node_modules `.js`); array position does not matter for ordering
  // relative to Vite's own esbuild plugin, since `enforce: "pre"` alone
  // decides that.
  plugins.push(
    jsxInJsPlugin(resolveJsxImportSource(projectRoot, workspaceRoot, absoluteComponentPath)),
  );
  const compileOptions = harnessServerCompileOptions(
    renderer,
    projectRoot,
    workspaceRoot,
    absoluteComponentPath,
    preBuild.resolveConditions,
  );
  // Appended, never substituted: the Tailwind entries above must survive.
  if (reactCompiler.active) {
    plugins.push(...(await loadReactCompilerPlugin(reactCompiler.pluginPath!, reactCompiler.target)));
  }

  // M48: the project's own transforms, resolved from its own node_modules with
  // server hooks stripped. Load failure warns and continues.
  const transformWarnings: string[] = [];
  const transformEntries = options?.noTransforms
    ? []
    : detectProjectTransforms(projectRoot, workspaceRoot, (w) => transformWarnings.push(w));
  if (transformEntries.length > 0) {
    plugins.push(
      ...(await loadProjectTransformPlugins(projectRoot, transformEntries, (warning) =>
        transformWarnings.push(warning),
      )),
    );
  }

  // M69: Vite refuses to serve a file outside its allow list. Undefined for a
  // project whose alias targets are all inside its own root, which keeps
  // Vite's defaults everywhere they already worked.
  // Vite's own default is the one root it searches for; widening never narrows
  // it, so its answer joins the list whenever the list exists at all.
  // M73: Vite serves nothing outside its allow list, so a component reached
  // through /@fs/ needs its own directory named.
  const aliasAllow = fsAllowDirs(
    projectRoot,
    workspaceRoot,
    alias,
    componentRelative.startsWith("@fs/") ? [componentDir] : [],
  );
  const fsAllow = aliasAllow && [...new Set([...aliasAllow, searchForWorkspaceRoot(projectRoot)])];

  // M71: without these the page has no `process` at all, and a component
  // reading process.env throws before it renders.
  const define = readEnvDefines(projectRoot, workspaceRoot);

  // The rebuilt Tailwind 3 pipeline wins over the inherited config directory:
  // it is that directory's config, already loaded, with the config path the
  // member's own search would have found.
  const postcssOption: string | { plugins: unknown[] } | undefined =
    tailwind3Postcss ?? styleTooling.postcssConfigDir;

  const bootServer = async (): Promise<ViteDevServer> => {
    const created = await createServer({
      root: projectRoot,
      // The project's vite.config is not ours to run: its plugins target the
      // project's own Vite major (a rolldown plugin-react in a Vite 6 container
      // fails every transform), and its server options are not measurement-safe.
      // Aliases and the plugins we do need are reconstructed above by hand.
      configFile: false,
      logLevel: "silent",
      plugins: plugins as never,
      define,
      // The project's own static directory, recovered from the config text: its
      // fonts 404 otherwise and every text metric becomes a fallback-font one.
      ...(viteConfig.publicDir ? { publicDir: viteConfig.publicDir } : {}),
      // Vite searches from its root up to its own idea of the workspace root,
      // which a lockfile-only monorepo root does not satisfy; naming the
      // directory is a no-op wherever its own walk already reaches.
      // M106 A3: postcss and the folded preprocessor options share one `css`
      // object — twenty declares both, and passing either alone dropped the
      // other.
      ...(postcssOption || viteConfig.preprocessorOptions
        ? {
            css: {
              ...(postcssOption ? { postcss: postcssOption as never } : {}),
              ...(viteConfig.preprocessorOptions
                ? { preprocessorOptions: viteConfig.preprocessorOptions }
                : {}),
            },
          }
        : {}),
      server: {
        port: 0,
        strictPort: false,
        // With the overlay on, Vite renders transform failures into a DOM element
        // and logs nothing; with it off the client console.errors the full
        // message, which the page-error capture turns into a usable diagnosis.
        hmr: { overlay: false },
        // M34: nothing edits files during a measurement run, so file watching is
        // pure cost: chokidar's initial scan of a real repo (a Next.js .next/
        // dir has thousands of files) saturates the fs threadpool exactly when
        // the first module loads, and a watcher-triggered reload mid-measurement
        // is the failure M30's context retry exists for.
        watch: null,
        ...(fsAllow ? { fs: { allow: fsAllow } } : {}),
      },
      // M109 (A3): what the project's tsconfig says about `jsx` never decides
      // how the harness compiles its .ts/.tsx/.jsx. M109 (A5): resolve
      // conditions carry the governing tsconfig's customConditions.
      ...(compileOptions.esbuild ? { esbuild: compileOptions.esbuild } : {}),
      resolve: {
        alias,
        dedupe: renderer === "vue" ? ["vue"] : ["react", "react-dom"],
        // M76: a pass-through to Vite's own condition-aware exports resolver.
        ...(compileOptions.conditions ? { conditions: compileOptions.conditions } : {}),
      },
      optimizeDeps: {
        include: stableInclude,
      },
    });
    await created.listen();
    return created;
  };

  let server: ViteDevServer;
  let ownsServer = true;
  const buildWarnings: string[] = [
    ...transformWarnings,
    ...sweepWarnings,
    ...new Set(configWarnings),
  ];
  try {
    if (options?.serverPool) {
      // The tuple that shapes a server; anything else is per-component and
      // lives in the harness dir, not the server.
      const poolKey = JSON.stringify([
        projectRoot,
        [...cssFiles].sort(),
        options?.wrapPath ? path.resolve(options.wrapPath) : null,
        reactCompiler.active,
        options?.noShims ?? false,
      ]);
      const acquired = await options.serverPool.acquire(poolKey, bootServer, stableInclude);
      server = acquired.server;
      ownsServer = false;
      if (acquired.reused) {
        const missing = stableInclude.filter((dep) => !acquired.include.has(dep));
        if (missing.length > 0) buildWarnings.push(SWEEP_DEP_WARNING(missing));
      }
    } else {
      server = await bootServer();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // M92: surface 1 of the shared pipeline (presentBundlerFailure) -- the
    // dev server itself never started. M79 (3a)'s own case (Vite/esbuild's
    // message blaming a workspace-internal package's package.json fields when
    // the real problem is that the package was never built) is the first
    // diagnoser this chain tries; every other shape falls through in turn,
    // stripBundlerStackFrames as the universal last resort.
    const detail = presentBundlerFailure(message, projectRoot, buildWarnings);
    // M83 #7: the common, caught-and-rethrown failure shape (nuxt-ui F1/F2,
    // mantine F1, dub F1, chakra-ui F3/F4). cleanup() is only ever
    // constructed on the success path, so this catch is the one place the
    // directory would otherwise leak on every one of these.
    fs.rmSync(harnessDir, { recursive: true, force: true });
    activeHarnessDirs.delete(harnessDir);
    // M79 (1a): everything buildWarnings would have carried on the success
    // path travels with the thrown error too, so a crash after a computed
    // warning (VITE_CONFIG_IGNORED_WARNING, an unreplicated style engine, a
    // transform-load failure) does not silently drop it.
    throw Object.assign(new Error(VITE_START_FAILED(harnessDir, detail)), {
      cause: err,
      warnings: buildWarnings,
    });
  }

  const address = server.httpServer?.address();
  let url: string;
  if (address && typeof address === "object") {
    url = `http://localhost:${address.port}/${harnessDirName}/`;
  } else {
    throw Object.assign(
      new Error(VITE_START_FAILED(harnessDir, "no listening address was returned")),
      { warnings: buildWarnings },
    );
  }

  const cleanup = async () => {
    if (ownsServer) await closeServerBounded(server);
    fs.rmSync(harnessDir, { recursive: true, force: true });
    activeHarnessDirs.delete(harnessDir);
  };

  return {
    url,
    server,
    componentPath: absoluteComponentPath,
    harnessDir,
    cleanup,
    component,
    nextJsShims: activeShims,
    reactCompiler,
    ...(wrapRelative !== undefined
      ? { wrapPath: path.resolve(options!.wrapPath!), wrapRelative }
      : {}),
    ...(cssFiles.length > 0 ? { cssFiles } : {}),
    ...(viteConfig.aliases.length > 0 ? { viteAliases: viteConfig.aliases } : {}),
    ...(buildWarnings.length > 0 ? { warnings: buildWarnings } : {}),
  };
}

// M34: any change to optimizeDeps.include changes Vite's config hash, and a
// changed hash forces a full dependency re-bundle (~10s) on the next run. The
// scanned list varies per component, so every component of a sweep paid it.
// Union the list with whatever the project's dep cache already optimized: the
// list converges to a stable superset and repeat runs hit the cache. A missing
// or corrupt cache costs one re-bundle, nothing else.
export function unionCachedDeps(
  include: string[],
  metadataJson: string | undefined,
): string[] {
  let cached: string[] = [];
  if (metadataJson) {
    try {
      const parsed = JSON.parse(metadataJson) as { optimized?: Record<string, unknown> };
      cached = Object.keys(parsed.optimized ?? {});
    } catch {
      // Not ours to repair; Vite rewrites it on the next optimize pass.
    }
  }
  return [...new Set([...include, ...cached])].sort();
}

function readDepCacheMetadata(projectRoot: string): string | undefined {
  try {
    return fs.readFileSync(
      path.join(projectRoot, "node_modules", ".vite", "deps", "_metadata.json"),
      "utf8",
    );
  } catch {
    return undefined;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A directory with no pid marker was created by a build that did not write one:
// nothing here can tell whether it is in use, so it keeps the original,
// conservative gate (M24 D8).
export const STALE_HARNESS_MAX_AGE_MS = 60 * 60 * 1000;
// M101: a marked directory whose process is alive is in use — until it has been
// sitting for this long, at which point the pid is more likely recycled than
// still measuring.
export const LIVE_PID_HARNESS_MAX_AGE_MS = 10 * 60 * 1000;

// Best-effort removal of .120fps-harness-* leftovers. M101: a directory whose
// marked owner is gone is removed at any age — that is exactly the leftover an
// external kill produces (V2 repro 5), and waiting an hour for it served no
// purpose once the owner is known.
// M101 (dub leftover): a removal that cannot succeed used to be swallowed with
// the same `catch` that covers "already gone", so a directory another process
// still holds open looked identical to one nothing was wrong with. The reason
// is now the run's own disclosure.
export function HARNESS_DIR_UNREMOVABLE_WARNING(dir: string, reason: string): string {
  return (
    `${dir} is a leftover harness directory this run could not remove (${reason}). It belongs to a ` +
    "120fps process that is gone or idle; remove it by hand, or close whatever still holds a file " +
    "inside it open."
  );
}

// M113 A5: the run that removed a leftover said nothing, so the developer had
// no evidence the previous run had left anything behind at all.
export function HARNESS_DIR_SWEPT_WARNING(dir: string, reason: string): string {
  return `Removed a stale harness directory from an earlier run: ${dir} (${reason}).`;
}

export function sweepStaleHarnessDirs(
  projectRoot: string,
  warningsOut?: string[],
  // Injected so the failure path is testable without contriving a real
  // Windows lock; every caller uses the default.
  remove: (dir: string) => void = (dir) => fs.rmSync(dir, { recursive: true, force: true }),
): void {
  try {
    const now = Date.now();
    // M113 A6: the retries are bounded across the whole sweep, so a root full
    // of locked leftovers cannot delay the start of a run.
    const deadline = now + HARNESS_SWEEP_BUDGET_MS;
    for (const entry of fs.readdirSync(projectRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(".120fps-harness-")) continue;
      const full = path.join(projectRoot, entry.name);
      try {
        const owner = harnessDirOwnerPid(full);
        // Never this process's own directory, at any age: this run knows it is
        // still using it, and its own exit paths already remove it.
        if (owner === process.pid) continue;
        const staleBecause =
          owner === undefined
            ? now - fs.statSync(full).mtimeMs > STALE_HARNESS_MAX_AGE_MS
              ? "unmarked and older than the age gate"
              : undefined
            : !isProcessAlive(owner)
              ? "its owner process is gone"
              : now - (harnessDirHeartbeatMs(full) ?? 0) > LIVE_PID_HARNESS_MAX_AGE_MS
                ? "its owner stopped heartbeating"
                : undefined;
        if (staleBecause === undefined) continue;
        const shown = path.relative(projectRoot, full).replace(/\\/g, "/") || entry.name;
        const failure = removeHarnessDirWithRetries(full, remove, deadline);
        warningsOut?.push(
          failure === undefined
            ? HARNESS_DIR_SWEPT_WARNING(shown, staleBecause)
            : HARNESS_DIR_UNREMOVABLE_WARNING(shown, failure),
        );
      } catch {
        // best-effort: the directory may have vanished between readdir and stat
      }
    }
  } catch {
    // best-effort: unreadable project root
  }
}

const TMP_SWEEP_PREFIX = /^\.?120fps-/;
const TMP_SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Bounds worst-case sweep time against a pathologically large temp dir; any
// remainder is picked up on the next sweep.
export const TMP_SWEEP_MAX_REMOVALS = 500;

// M56: best-effort removal of this tool's own OS-tmp leftovers (e.g.
// `120fps-ctx-*`, `120fps-memo-*`) older than 24h. A directory belonging to a
// live run is by construction younger than the cutoff, so no lockfile is
// needed: prefix + location + age is a three-factor guard against deleting
// anything foreign. Takes baseDir as a parameter for testability; real runs
// use the OS temp dir.
export function sweepStaleTmpDirs(baseDir: string = os.tmpdir()): void {
  try {
    const cutoff = Date.now() - TMP_SWEEP_MAX_AGE_MS;
    let removed = 0;
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (removed >= TMP_SWEEP_MAX_REMOVALS) break;
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (!TMP_SWEEP_PREFIX.test(entry.name)) continue;
      const full = path.join(baseDir, entry.name);
      try {
        // lstat, not stat: never follow a symlink out of the temp dir.
        const stat = fs.lstatSync(full);
        if (!stat.isDirectory() || stat.mtimeMs >= cutoff) continue;
        fs.rmSync(full, { recursive: true, force: true });
        removed++;
      } catch {
        // best-effort: in use, permission-denied, or already gone
      }
    }
  } catch {
    // best-effort: unreadable or nonexistent temp dir
  }
}

// Files worth reading for further imports. A .json or an asset is a leaf.
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts", ".vue"];
const EXTENSIONS = [...SOURCE_EXTENSIONS, ".json"];

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

// M69: a directory import answers through its manifest before its index file,
// the way node and Vite resolve it.
function resolveDirectoryEntry(dir: string): string | undefined {
  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
  } catch {
    return undefined;
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return undefined;
  const fields = manifest as Record<string, unknown>;
  const candidates = [
    conditionalEntry(fields.exports),
    typeof fields.module === "string" ? fields.module : undefined,
    typeof fields.main === "string" ? fields.main : undefined,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = resolveFileWithExtension(path.resolve(dir, candidate));
    if (resolved) return resolved;
  }
  return undefined;
}

// The root export of an "exports" map, in the order a bundler reads it. Nested
// condition objects are followed one level, which covers { ".": { import: ... } }
// and { ".": { node: { import: ... } } }.
function conditionalEntry(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value) || depth > 2) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const root = depth === 0 && "." in record ? record["."] : record;
  if (typeof root === "string") return root;
  if (typeof root !== "object" || root === null) return undefined;
  for (const condition of ["import", "module", "browser", "default", "require"]) {
    const entry = (root as Record<string, unknown>)[condition];
    const resolved = conditionalEntry(entry, depth + 1);
    if (resolved) return resolved;
  }
  return undefined;
}

function resolveFileWithExtension(target: string): string | undefined {
  if (isFile(target)) return target;
  for (const ext of EXTENSIONS) {
    if (isFile(target + ext)) return target + ext;
  }
  return undefined;
}

function resolveTarget(target: string): string | undefined {
  const direct = resolveFileWithExtension(target);
  if (direct) return direct;
  const fromManifest = resolveDirectoryEntry(target);
  if (fromManifest) return fromManifest;
  for (const ext of EXTENSIONS) {
    const indexFile = path.join(target, "index" + ext);
    if (isFile(indexFile)) return indexFile;
  }
  return undefined;
}

// M62: the alias that resolved a bare specifier matters for shim-usage
// reporting, not just where it points: a shim alias redirects a real
// package specifier to a local file, and that specifier is still "imported"
// even though this function treats the result as local. Returning
// viaShimAlias lets the caller record it without this function knowing
// anything about SHIM_MODULES.
// M69: "no alias matched" and "an alias matched and its target is gone" are
// different facts. Collapsing them into null pushed a stale alias into
// optimizeDeps.include as if a package by that name existed.
type LocalResolution =
  | {
      kind: "resolved";
      path: string;
      viaShimAlias: boolean;
      viaWorkspaceRootAlias?: WorkspaceRootAliasSource;
    }
  | {
      kind: "alias-miss";
      target: string;
      viaShimAlias: boolean;
      viaWorkspaceRootAlias?: WorkspaceRootAliasSource;
    }
  | { kind: "unaliased" };

// M107 (directus-F1): a package written for NodeNext resolution imports its
// own modules with the extension of the build output (`./parse-now.js`), and
// only the TypeScript source is on disk. Without this the walk stops at the
// first file of an aliased sibling and never sees the siblings that file
// imports. Same mapping TypeScript itself applies, source extensions only.
const TS_COUNTERPARTS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
  ".jsx": [".tsx"],
};

function resolveTypeScriptCounterpart(target: string): string | undefined {
  const extension = path.extname(target);
  const counterparts = TS_COUNTERPARTS[extension];
  if (counterparts === undefined) return undefined;
  const stem = target.slice(0, target.length - extension.length);
  for (const counterpart of counterparts) {
    if (isFile(stem + counterpart)) return stem + counterpart;
  }
  return undefined;
}

function resolveLocalImport(
  fromFile: string,
  spec: string,
  projectRoot: string,
  aliases: Array<{
    find: RegExp;
    replacement: string;
    isShim?: boolean;
    fromWorkspaceRoot?: WorkspaceRootAliasSource;
  }>,
): LocalResolution {
  let target: string;
  let viaShimAlias = false;
  let viaWorkspaceRootAlias: WorkspaceRootAliasSource | undefined;
  let aliased = false;
  if (spec.startsWith(".") || spec.startsWith("/")) {
    target = path.resolve(path.dirname(fromFile), spec);
  } else {
    let aliasedPath: string | undefined;
    for (const { find, replacement, isShim, fromWorkspaceRoot } of aliases) {
      if (find.test(spec)) {
        aliasedPath = spec.replace(find, replacement);
        viaShimAlias = isShim === true;
        viaWorkspaceRootAlias = fromWorkspaceRoot;
        break;
      }
    }
    if (aliasedPath === undefined) return { kind: "unaliased" };
    aliased = true;
    target = path.isAbsolute(aliasedPath) ? aliasedPath : path.resolve(projectRoot, aliasedPath);
  }

  const resolved = resolveTarget(target) ?? resolveTypeScriptCounterpart(target);
  if (resolved) return { kind: "resolved", path: resolved, viaShimAlias, viaWorkspaceRootAlias };
  if (!aliased) return { kind: "unaliased" };
  return {
    kind: "alias-miss",
    target: target.replace(/\\/g, "/"),
    viaShimAlias,
    viaWorkspaceRootAlias,
  };
}

// Static imports and re-exports, dynamic import(), and require(). String
// literals only: a template literal or a computed specifier is unknowable
// without running the code.
// M77: the negative lookahead excludes a whole-clause `import type`/`export
// type` from-specifier: type-space, never loaded at runtime. A mixed clause
// (`import { type A, b } from "x"`) still matches, because `b` is a real
// value import and "x" genuinely needs runtime resolution.
// M110 (A4, gutenberg): a clause written over several lines
// (`import {`, `  escapeHTML,`, `} from "@wordpress/escape-html"`) is the same
// import. `[^;'"]*?` spans newlines where `.` did not, and stops at the two
// characters that can end a statement before its own `from`: a `;`, or the
// quote of a side-effect import standing above the clause
// (`import "./a.css"`), which stays its own match instead of being swallowed
// into the one below it.
const STATIC_IMPORT_PATTERN =
  /(?:^|\s)(?:import|export)\s+(?!type\s)[^;'"]*?from\s+["']([^"']+)["']|(?:^|\s)import\s+["']([^"']+)["']/gm;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*["']([^"']+)["']/g;
const REQUIRE_PATTERN = /\brequire\s*\(\s*["']([^"']+)["']/g;

function readSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of [STATIC_IMPORT_PATTERN, DYNAMIC_IMPORT_PATTERN, REQUIRE_PATTERN]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const spec = match[1] ?? match[2];
      if (spec) specifiers.push(spec);
    }
  }
  return specifiers;
}

// M110 (A1, epic-stack-F2): the scan used to `continue` past a specifier that
// resolved to nothing, so `--explain-props` and the real run both stayed silent
// until the dev server died on it at dep-optimization.
export function UNRESOLVED_PREBUNDLE_ENTRY_WARNING(specifier: string, importer: string): string {
  return (
    `"${specifier}" (imported by ${importer}) resolves to no installed package, no alias and no ` +
    "`imports` entry, so the pre-bundle cannot include it: the browser resolves it at request time " +
    "or fails on it."
  );
}

export function BROKEN_ALIAS_WARNING(specifier: string, target: string): string {
  return (
    `import "${specifier}" matches a configured path alias, but its target ${target} does not exist; ` +
    "the alias is stale or the file was moved, and the import will not resolve in the harness"
  );
}

// M77: proven, not guessed — the package resolves to an installed directory
// whose own package.json has no main/module/exports and no index file, the
// same "no loadable entry" primitive the types-only paths-alias check (1)
// uses.
export function TYPE_ONLY_PACKAGE_WARNING(pkg: string): string {
  return (
    `import "${pkg}" resolved to an installed package with no runtime entry ` +
    "(no package.json main/module/exports, no index file); the import is almost certainly " +
    "type-only and was excluded from the pre-bundle instead of aborting the harness"
  );
}

// M94 (dub-F1): a workspace sibling's own source, not its declared (unbuilt)
// dist/, now answers for the bare specifier — the alias applies to Vite's
// real per-request resolution, not only optimizeDeps, so this import
// resolves rather than merely avoiding one particular crash site.
// M107: the message names the manifest field the derivation followed, the
// path that field declared and whether that path is on disk, so no message
// claims a `dist/` the package never named.
export function UNBUILT_WORKSPACE_SOURCE_ALIAS_WARNING(
  pkg: string,
  sourceEntry: string,
  entry?: { field: string; declared: string; exists: boolean },
): string {
  if (entry === undefined) {
    return (
      `${pkg} is a workspace package with no built entry to load; its own source at ${sourceEntry} ` +
      "resolves and was aliased in its place, so this run measures the real module."
    );
  }
  const existence = entry.exists ? "exists on disk" : "does not exist on disk";
  return (
    `${pkg} is a workspace package whose ${entry.field} names ${entry.declared}, which ${existence}; ` +
    `its own source at ${sourceEntry} resolves and was aliased in its place, so this run measures ` +
    "the real module."
  );
}

// M107 (react-spectrum-F1): a workspace sibling that declares no runtime entry
// at all ships declarations only. It is not an unbuilt package, nothing about
// it can fail when the browser loads it, and no build command helps.
export function TYPES_ONLY_WORKSPACE_PACKAGE_WARNING(
  pkg: string,
  typesPath: string | undefined,
): string {
  return (
    `${pkg} is a workspace package that declares no runtime entry (no main, module or exports)` +
    (typesPath ? `, only types at ${typesPath}` : "") +
    "; it ships declarations only, so it was left out of the pre-bundle and needs no build."
  );
}

// M94 (dub-F2): the honest replacement for TYPE_ONLY_PACKAGE_WARNING when the
// package is a workspace sibling, not a genuinely external dependency: this
// import is not proven type-only, and excluding it from the pre-bundle does
// not stop Vite's own per-request resolution from hitting the identical
// unresolvable specifier the moment the browser loads the importing file —
// the "excluded... instead of aborting the harness" promise TYPE_ONLY_PACKAGE_WARNING
// makes is not true here.
export function UNBUILT_WORKSPACE_PACKAGE_NO_SOURCE_WARNING(
  pkg: string,
  buildCommand: string | undefined,
  entry?: { field: string; declared: string; exists: boolean },
): string {
  const build = buildCommand ? ` Run \`${buildCommand}\` in that package first.` : "";
  if (entry === undefined) {
    return (
      `${pkg} is a workspace package whose package.json points at an unbuilt dist/, and no ` +
      "resolvable source was found to measure instead: this import may still fail when the browser " +
      "loads it, not only at pre-bundle time." +
      build
    );
  }
  const existence = entry.exists ? "exists on disk" : "does not exist on disk";
  return (
    `${pkg} is a workspace package whose ${entry.field} names ${entry.declared}, which ${existence}, ` +
    "and no resolvable source was found to measure instead: this import may still fail when the " +
    "browser loads it, not only at pre-bundle time." +
    build
  );
}

// M107 (review): a subpath specifier of a sibling whose root was aliased is
// removed from the pre-bundle by that root decision alone. Nothing aliased the
// subpath itself, so the removal is disclosed instead of silent.
export function UNALIASED_WORKSPACE_SUBPATH_WARNING(specifier: string, pkg: string): string {
  return (
    `${specifier} is a subpath of the workspace package ${pkg}, whose root was aliased to its own ` +
    "source; that subpath resolved to no source of its own and was left out of the pre-bundle, so " +
    "this import may still fail when the browser loads it, not only at pre-bundle time."
  );
}

// M76: resolvePackageDir walks the node_modules resolution chain the same way
// isInstalledOnResolutionChain (project-model.ts) does, but returns where a
// package lives instead of whether it does.
function resolvePackageDir(pkg: string, fromDir: string): string | undefined {
  let current = path.resolve(fromDir);
  while (true) {
    if (path.basename(current) !== "node_modules") {
      const candidate = path.join(current, "node_modules", ...pkg.split("/"));
      if (isFile(path.join(candidate, "package.json"))) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

// M76: true when an installed package's realpath sits inside workspaceRoot
// with no node_modules segment between them — the standard signal that an
// install is a symlink back into the monorepo's own source tree, not a
// hoisted external copy.
function isWorkspaceSibling(pkgDir: string, workspaceRoot: string): boolean {
  let real: string;
  try {
    real = fs.realpathSync(pkgDir);
  } catch {
    return false;
  }
  const relative = path.relative(path.resolve(workspaceRoot), real).replace(/\\/g, "/");
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  return !relative.split("/").includes("node_modules");
}

// M107: the manifest fields that can name a runtime entry, in the order the
// source derivation tries them.
type DeclaredEntry = { field: string; declared: string };

const EXPORT_ENTRY_CONDITIONS = ["development", "source", "import", "default", "require"];

const DECLARATION_FILE = /\.d\.[cm]?ts$/;

function exportConditionTargets(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object" || Array.isArray(value) || depth > 2) return [];
  const record = value as Record<string, unknown>;
  const targets: string[] = [];
  for (const condition of EXPORT_ENTRY_CONDITIONS) {
    if (!(condition in record)) continue;
    for (const target of exportConditionTargets(record[condition], depth + 1)) {
      if (!targets.includes(target)) targets.push(target);
    }
  }
  return targets;
}

function exportsRootTargets(exportsField: unknown): string[] {
  if (typeof exportsField === "string") return [exportsField];
  if (exportsField === null || typeof exportsField !== "object" || Array.isArray(exportsField)) {
    return [];
  }
  const record = exportsField as Record<string, unknown>;
  if ("." in record) return exportConditionTargets(record["."]);
  // A sugar form: conditions at the top level, no subpath keys at all.
  if (Object.keys(record).some((key) => key.startsWith("."))) return [];
  return exportConditionTargets(record);
}

function declaredRuntimeEntries(manifest: Record<string, unknown>): DeclaredEntry[] {
  const entries: DeclaredEntry[] = [];
  if (typeof manifest.source === "string") entries.push({ field: "source", declared: manifest.source });
  for (const declared of exportsRootTargets(manifest.exports)) {
    entries.push({ field: 'exports["."]', declared });
  }
  if (typeof manifest.module === "string") entries.push({ field: "module", declared: manifest.module });
  if (typeof manifest.main === "string") entries.push({ field: "main", declared: manifest.main });
  return entries;
}

function declaresRuntimeEntry(manifest: Record<string, unknown> | undefined): boolean {
  if (!manifest) return false;
  return ["source", "exports", "module", "main"].some((field) => manifest[field] !== undefined);
}

// M107: a declared entry names a build output, and the source it was built
// from sits at the same path with the build directory dropped and a source
// extension applied (`dist/shared/index.js` -> `shared/index.ts`).
function sourceCandidatesFor(real: string, declared: string): string[] {
  const normalized = declared.replace(/\\/g, "/").replace(/^\.\//, "");
  const withoutExtension = (value: string) => value.replace(/\.[^./]+$/, "");
  const relatives = [normalized, withoutExtension(normalized)];
  const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length > 1) {
    const tail = segments.slice(1).join("/");
    relatives.push(withoutExtension(tail), tail);
  }
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const relative of relatives) {
    if (relative.length === 0 || relative === ".." || seen.has(relative)) continue;
    seen.add(relative);
    candidates.push(path.resolve(real, relative));
  }
  return candidates;
}

function resolveSourceCandidate(real: string, declared: string): string | undefined {
  for (const candidate of sourceCandidatesFor(real, declared)) {
    const resolved = resolveTarget(candidate);
    if (resolved !== undefined && !DECLARATION_FILE.test(resolved)) {
      return resolved.replace(/\\/g, "/");
    }
  }
  return undefined;
}

type WorkspaceSourceEntry = {
  entry: string;
  field: string;
  declared: string;
  declaredExists: boolean;
};

// M107 (directus-F1, gutenberg-F1): the source an unbuilt workspace sibling
// declares, whatever layout it uses. `<pkg>/src` is the last fallback, not the
// only candidate.
function resolveWorkspaceSourceEntry(
  real: string,
  manifest: Record<string, unknown> | undefined,
): WorkspaceSourceEntry | undefined {
  const declaredEntries = manifest ? declaredRuntimeEntries(manifest) : [];
  const declaredExists = (declared: string) => fs.existsSync(path.resolve(real, declared));
  for (const candidate of declaredEntries) {
    const resolved = resolveSourceCandidate(real, candidate.declared);
    if (resolved !== undefined) {
      return {
        entry: resolved,
        field: candidate.field,
        declared: candidate.declared,
        declaredExists: declaredExists(candidate.declared),
      };
    }
  }
  const primary = declaredEntries[0];
  const types = manifest && typeof manifest.types === "string" ? manifest.types : undefined;
  if (types !== undefined && DECLARATION_FILE.test(types)) {
    const stem = path.resolve(real, types.replace(/\\/g, "/").replace(DECLARATION_FILE, ""));
    for (const extension of SOURCE_EXTENSIONS) {
      if (!isFile(stem + extension)) continue;
      return {
        entry: (stem + extension).replace(/\\/g, "/"),
        field: "types",
        declared: types,
        declaredExists: declaredExists(types),
      };
    }
  }
  const fallback = resolveTarget(path.join(real, "src"));
  if (fallback === undefined || DECLARATION_FILE.test(fallback)) return undefined;
  return {
    entry: fallback.replace(/\\/g, "/"),
    field: primary?.field ?? "src",
    declared: primary?.declared ?? "src",
    declaredExists: primary === undefined ? true : declaredExists(primary.declared),
  };
}

// M107 (directus-F1): an `exports` subpath key gets the same derivation as the
// root entry. A key whose declared target already resolves needs no source
// counterpart and keeps the resolution it has today.
function workspaceSubpathSourceEntries(
  real: string,
  manifest: Record<string, unknown> | undefined,
): Array<{ subpath: string; entry: string }> {
  const exportsField = manifest?.exports;
  if (!exportsField || typeof exportsField !== "object" || Array.isArray(exportsField)) return [];
  const rescued: Array<{ subpath: string; entry: string }> = [];
  for (const [key, value] of Object.entries(exportsField as Record<string, unknown>)) {
    if (!key.startsWith("./") || key === "./package.json" || key.includes("*")) continue;
    for (const declared of exportConditionTargets(value)) {
      const literal = resolveTarget(path.resolve(real, declared.replace(/^\.\//, "")));
      if (literal !== undefined) break;
      const resolved = resolveSourceCandidate(real, declared);
      if (resolved === undefined || !SOURCE_EXTENSIONS.includes(path.extname(resolved))) continue;
      rescued.push({ subpath: key.slice(2), entry: resolved });
      break;
    }
  }
  return rescued;
}

// M108 A1 (epic-stack-F1): Node's subpath-imports map, the way Vite reads it.
// The conditions are the browser-development set Vite resolves a dev request
// with; `types` and `node` deliberately absent, `require` last-resort only.
const SUBPATH_IMPORT_CONDITIONS = [
  "source",
  "development",
  "browser",
  "module",
  "import",
  "require",
  "default",
];

function nearestManifestDir(fromDir: string): string | undefined {
  let dir = path.resolve(fromDir);
  for (;;) {
    if (isFile(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// Conditions are declaration-ordered in Node's algorithm: the first key this
// resolver recognises wins, and an array is a fallback list.
function pickConditionalTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const picked = pickConditionalTarget(entry);
      if (picked) return picked;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const [condition, nested] of Object.entries(value as Record<string, unknown>)) {
      if (!SUBPATH_IMPORT_CONDITIONS.includes(condition)) continue;
      const picked = pickConditionalTarget(nested);
      if (picked) return picked;
    }
  }
  return undefined;
}

// The file a "#"-prefixed specifier names, resolved through the `imports` map
// of the importer's OWN package (a workspace member's map, not the measured
// root's). Undefined when no map declares it: that specifier stays unresolved
// and gets the generic missing-subpath diagnosis, never an optimizeDeps entry.
function pickSubpathImportTarget(
  importerFile: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith("#")) return undefined;
  const pkgDir = nearestManifestDir(path.dirname(importerFile));
  if (!pkgDir) return undefined;
  const manifest = readProjectManifest(pkgDir);
  const imports = manifest?.imports;
  if (!imports || typeof imports !== "object") return undefined;

  const entries = Object.entries(imports as Record<string, unknown>);
  let target = entries.find(([key]) => key === specifier)?.[1];
  let substitution: string | undefined;
  if (target === undefined) {
    // Longest matching prefix wins, as Node's PATTERN_KEY_COMPARE does.
    let bestPrefix = "";
    for (const [key, value] of entries) {
      const star = key.indexOf("*");
      if (star < 0) continue;
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
      if (specifier.length < prefix.length + suffix.length) continue;
      if (prefix.length < bestPrefix.length) continue;
      bestPrefix = prefix;
      target = value;
      substitution = specifier.slice(prefix.length, specifier.length - suffix.length);
    }
  }

  const picked = pickConditionalTarget(target);
  if (!picked) return undefined;
  const filled = substitution === undefined ? picked : picked.split("*").join(substitution);
  return picked.startsWith(".") ? path.resolve(pkgDir, filled) : filled;
}

export function resolveSubpathImport(
  importerFile: string,
  specifier: string,
): string | undefined {
  const target = pickSubpathImportTarget(importerFile, specifier);
  if (!target || !path.isAbsolute(target)) return undefined;
  return resolveTarget(target);
}

// M108 review: an `imports` entry may point at a dependency ("#dep":
// "lodash-es") instead of a file of the package's own. That edge is an
// ordinary external import and belongs in the pre-bundle list; dropped, Vite
// discovers it on the first page load and forces the full reload the
// pre-bundle list exists to prevent.
export function subpathImportPackage(
  importerFile: string,
  specifier: string,
): string | undefined {
  const target = pickSubpathImportTarget(importerFile, specifier);
  if (!target || path.isAbsolute(target) || target.startsWith(".") || target.startsWith("#")) {
    return undefined;
  }
  return target;
}

export function scanExternalDeps(
  componentPath: string,
  projectRoot: string,
  aliases: Array<{
    find: RegExp;
    replacement: string;
    isShim?: boolean;
    fromWorkspaceRoot?: WorkspaceRootAliasSource;
  }>,
  specifiersOut?: Set<string>,
  warningsOut?: string[],
  workspaceRoot: string = findWorkspaceRoot(projectRoot),
  // M94: a workspace-sibling package rescued by aliasing to its own source
  // (see the M77 exclusion loop below) pushes its alias here; the one caller
  // (buildAndServe) passes the same array it is already assembling `alias`
  // from, so the rescue applies to Vite's real per-request resolution too,
  // not only to optimizeDeps.
  extraAliasesOut?: Array<{ find: RegExp; replacement: string }>,
  // M110 (A2/I2): the specifiers this walk could not resolve, in the order it
  // read them, for the caller that publishes them on `StaticPreBuild`.
  unresolvedOut?: Array<{ specifier: string; importer: string }>,
): string[] {
  const externalPkgs = new Set<string>();
  const visited = new Set<string>();
  const reportedBrokenAliases = new Set<string>();
  const reportedWorkspaceRootAliases = new Set<string>();
  // M110 (A1): one report per specifier, however many files import it.
  const reportedUnresolved = new Set<string>();
  const queue = [componentPath];
  const pkgNameOf = (spec: string) =>
    spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
  // M107: a sibling rescued in a later round is imported from inside another
  // package, where a pnpm install links dependencies the entry project's own
  // node_modules chain never carries. The directory the specifier was first
  // read from answers for it; projectRoot stays the first probe.
  const firstImporterDir = new Map<string, string>();
  // M107 (review): a specifier whose package directory no importer has yet
  // produced re-reads its importer from the newest file that imported it.
  const unresolvedImporters = new Set<string>();

  // M107 (gutenberg-F1): the walk runs again from every source an unbuilt
  // sibling was aliased to, so a sibling first reached through an import the
  // scanner could not resolve is rescued in the same pass.
  const walk = () => {
  while (queue.length > 0) {
    const file = queue.shift()!;
    const normalizedFile = path.resolve(file);
    if (visited.has(normalizedFile)) continue;
    visited.add(normalizedFile);

    let content: string;
    try {
      content = fs.readFileSync(normalizedFile, "utf-8");
    } catch {
      continue;
    }

    for (const raw of readSpecifiers(content)) {
      // M69: `./icon.svg?url` and `pkg/style.css?inline` never resolved with
      // the query attached. A "#" survives: it opens a Node subpath import and
      // a legitimate alias pattern.
      const spec = raw.split("?")[0];
      if (!spec) continue;

      const isBareSpecifier = !spec.startsWith(".") && !spec.startsWith("/");
      const localResolved = resolveLocalImport(normalizedFile, spec, projectRoot, aliases);
      if (localResolved.kind === "resolved") {
        if (SOURCE_EXTENSIONS.includes(path.extname(localResolved.path))) {
          queue.push(localResolved.path);
        }
        // M62: a shim alias redirects the specifier to a local file, but the
        // specifier itself was still imported and must be reported: the
        // resolution stays local (queued above), only the bookkeeping changes.
        if (isBareSpecifier && localResolved.viaShimAlias) specifiersOut?.add(spec);
        // M76: same idea for a workspace-root-sourced alias — usage-triggered
        // and deduped per specifier, so a root config with many patterns for
        // packages this component never touches does not bury the one that
        // actually mattered.
        if (
          isBareSpecifier &&
          localResolved.viaWorkspaceRootAlias &&
          !reportedWorkspaceRootAliases.has(spec)
        ) {
          reportedWorkspaceRootAliases.add(spec);
          const tag = localResolved.viaWorkspaceRootAlias;
          warningsOut?.push(WORKSPACE_ROOT_ALIAS_WARNING(spec, tag.pattern, tag.target, tag.configFile));
        }
      } else if (localResolved.kind === "alias-miss") {
        // A shim alias whose file is not built yet is this tool's own state,
        // and the specifier was still imported: M62's report needs it either
        // way. A project alias pointing nowhere is the project's to fix, and
        // it is never a package.
        if (localResolved.viaShimAlias) {
          specifiersOut?.add(spec);
        } else if (!reportedBrokenAliases.has(spec)) {
          reportedBrokenAliases.add(spec);
          warningsOut?.push(BROKEN_ALIAS_WARNING(spec, localResolved.target));
        }
      } else if (spec.startsWith("#")) {
        // M108 A1: a subpath import is the importer's own package talking to
        // itself. Resolved, it is an ordinary graph edge; unresolved, it is a
        // map that lacks the key — never a package to pre-bundle, and never a
        // truncation of one ("#app/utils/misc" collapsed to "#app" is what
        // manufactured epic-stack's failure).
        const viaImports = resolveSubpathImport(normalizedFile, spec);
        if (viaImports && SOURCE_EXTENSIONS.includes(path.extname(viaImports))) {
          queue.push(viaImports);
        } else if (!viaImports) {
          // The map may name a dependency rather than a local file; that target,
          // never the "#" specifier, is what a bundler pre-bundles.
          const viaPackage = subpathImportPackage(normalizedFile, spec);
          if (viaPackage) {
            specifiersOut?.add(viaPackage);
            externalPkgs.add(pkgNameOf(viaPackage));
          } else if (!reportedUnresolved.has(spec)) {
            // M110 (A1): no file, no package, no alias. Nothing can pre-bundle
            // it, and the specifier stays out of the include list (M108) — the
            // report is the only thing that was missing.
            reportedUnresolved.add(spec);
            const importer = relativeToRoot(normalizedFile, projectRoot);
            unresolvedOut?.push({ specifier: spec, importer });
            warningsOut?.push(UNRESOLVED_PREBUNDLE_ENTRY_WARNING(spec, importer));
          }
        }
      } else if (isBareSpecifier) {
        specifiersOut?.add(spec);
        const pkg = spec.startsWith("@")
          ? spec.split("/").slice(0, 2).join("/")
          : spec.split("/")[0];
        const importerDir = path.dirname(normalizedFile);
        if (!firstImporterDir.has(spec) || unresolvedImporters.has(spec)) {
          firstImporterDir.set(spec, importerDir);
          unresolvedImporters.delete(spec);
        }
        if (!firstImporterDir.has(pkg) || unresolvedImporters.has(pkg)) {
          firstImporterDir.set(pkg, importerDir);
          unresolvedImporters.delete(pkg);
        }
        if (spec === pkg) {
          // The specifier was already the bare root: unchanged, covers every
          // ordinary dependency including subpath-only ones like swiper.
          externalPkgs.add(pkg);
        } else {
          // M76: a subpath specifier. Collapsing it to `pkg` unconditionally
          // manufactures an optimizeDeps entry nothing in the source wrote
          // when `pkg` is a workspace sibling whose own root has no
          // resolvable entry (an `exports` map with only subpath keys, no
          // `main`) — calcom-F1. Substitute the literal subpath instead, once
          // per distinct subpath; every other package keeps collapsing.
          const pkgDir = resolvePackageDir(pkg, path.dirname(normalizedFile));
          if (
            pkgDir &&
            isWorkspaceSibling(pkgDir, workspaceRoot) &&
            resolveDirectoryEntry(pkgDir) === undefined
          ) {
            externalPkgs.add(spec);
          } else {
            externalPkgs.add(pkg);
          }
        }
      }
    }
  }
  };

  const BLOCKED = new Set([
    "next", "webpack", "critters", "fibers",
    "react-server-dom-webpack", "react-server-dom-turbopack",
    "@vercel/turbopack-ecmascript-runtime",
    "@next/env", "@next/swc-linux-x64-gnu", "@next/swc-linux-x64-musl",
    "@next/swc-darwin-arm64", "@next/swc-darwin-x64",
    "@next/swc-win32-x64-msvc", "@next/swc-win32-arm64-msvc",
    "sass", "less", "stylus", "lightningcss", "sugarss",
  ]);

  // M76: an entry may now be a subpath string rather than a bare name, so the
  // blocklist's membership and prefix checks apply to the package-name
  // portion re-derived from each entry, not to the raw entry text.
  const dropIgnored = () => {
    externalPkgs.delete("react");
    externalPkgs.delete("react-dom");
    for (const entry of externalPkgs) {
      const pkg = pkgNameOf(entry);
      if (BLOCKED.has(pkg) || pkg.startsWith("@next/") || pkg.startsWith("@vercel/turbopack")) {
        externalPkgs.delete(entry);
      }
    }
  };

  // M77: a bare specifier that resolves to an installed package with no
  // runtime entry (no package.json main/module/exports, no index file) is
  // almost certainly type-only — the regex scanner cannot see that an import
  // is structurally type-only (`import * as CSS from 'csstype'`), so
  // correctness depends on this proof, not on syntax. A package this walk
  // cannot find at all is left alone: this only skips packages it has
  // proven lack a runtime entry, never ones it merely failed to locate.
  //
  // M94 (dub-F1/F2): that inference is wrong for a workspace sibling — its
  // "no runtime entry" only proves its *declared* dist/ is unbuilt, not that
  // the import is type-only, and excluding a genuinely value-imported bare
  // specifier from optimizeDeps does not stop Vite's own per-request
  // resolution from failing on the identical specifier the moment the
  // browser loads the file that imports it (dub's exact crash, right after
  // the "excluded from the pre-bundle" warning printed). A workspace sibling
  // with a resolvable src/ entry is aliased to it instead of excluded, so
  // both the optimizer and Vite's real resolver succeed; one with no
  // resolvable source anywhere is still excluded (nothing else is safe), but
  // the warning stops promising a crash it cannot actually prevent.
  //
  // M107: each sibling is decided once per pass; a sibling aliased to its own
  // source hands that source back to the walk, so the pass reaches a fixed
  // point instead of stopping at the first ring of imports.
  type SiblingDecision = { aliasedRoot: boolean; aliasedSpecifiers: Set<string> };
  const siblingDecisions = new Map<string, SiblingDecision>();
  const decidedEntries = new Set<string>();
  const keptEntries = new Set<string>();

  const reportedUnaliasedSubpaths = new Set<string>();
  const applyDecision = (entry: string, pkg: string, decision: SiblingDecision): void => {
    if (decision.aliasedSpecifiers.has(entry) || entry === pkg) {
      externalPkgs.delete(entry);
      return;
    }
    if (!decision.aliasedRoot) return;
    externalPkgs.delete(entry);
    if (reportedUnaliasedSubpaths.has(entry)) return;
    reportedUnaliasedSubpaths.add(entry);
    warningsOut?.push(UNALIASED_WORKSPACE_SUBPATH_WARNING(entry, pkg));
  };

  const resolvePackages = (): boolean => {
    let queuedSource = false;
    for (const entry of [...externalPkgs]) {
      const pkg = pkgNameOf(entry);
      const decided = siblingDecisions.get(pkg);
      if (decided !== undefined) {
        applyDecision(entry, pkg, decided);
        continue;
      }
      if (decidedEntries.has(entry)) {
        externalPkgs.delete(entry);
        continue;
      }
      if (keptEntries.has(entry)) continue;
      const importerDir = firstImporterDir.get(entry) ?? firstImporterDir.get(pkg);
      const dir =
        installedPackageDir(pkg, projectRoot) ??
        (importerDir === undefined ? undefined : resolvePackageDir(pkg, importerDir));
      if (dir === undefined) {
        // M107 (review): the importer this specifier was first read from may be
        // a file where the package is not installed; a later round can reach the
        // same specifier from a directory where it is, so the entry is left
        // undecided rather than kept for good.
        unresolvedImporters.add(entry);
        unresolvedImporters.add(pkg);
        continue;
      }
      if (!isWorkspaceSibling(dir, workspaceRoot)) {
        // A subpath of a package that is not a workspace sibling keeps the
        // resolution it has today (M76, calcom-F1).
        if (entry !== pkg || resolveTarget(dir) !== undefined) {
          keptEntries.add(entry);
          continue;
        }
        decidedEntries.add(entry);
        externalPkgs.delete(entry);
        warningsOut?.push(TYPE_ONLY_PACKAGE_WARNING(entry));
        continue;
      }
      // Realpath, not the node_modules symlink/junction location: the
      // physical source directory, matching isWorkspaceSibling's own check
      // and avoiding routing Vite's resolution and fs watching through the
      // link layer for no reason.
      let real: string;
      try {
        real = fs.realpathSync(dir);
      } catch {
        real = dir;
      }
      const manifest = readProjectManifest(real);
      // M107: a sibling that declares a runtime entry is unbuilt when that
      // entry does not resolve, whatever else happens to sit in its root; one
      // that declares none keeps M94's probe.
      const declaresEntry = declaresRuntimeEntry(manifest);
      if (
        resolveDirectoryEntry(dir) !== undefined ||
        (!declaresEntry && resolveTarget(dir) !== undefined)
      ) {
        keptEntries.add(entry);
        continue;
      }
      const decision: SiblingDecision = { aliasedRoot: false, aliasedSpecifiers: new Set() };
      siblingDecisions.set(pkg, decision);
      const source = declaresEntry ? resolveWorkspaceSourceEntry(real, manifest) : undefined;
      const subpaths = workspaceSubpathSourceEntries(real, manifest);
      if (source !== undefined) {
        decision.aliasedRoot = true;
        extraAliasesOut?.push({
          find: new RegExp(`^${escapeRegex(pkg)}$`),
          replacement: source.entry,
        });
        warningsOut?.push(
          UNBUILT_WORKSPACE_SOURCE_ALIAS_WARNING(pkg, source.entry, {
            field: source.field,
            declared: source.declared,
            exists: source.declaredExists,
          }),
        );
        if (SOURCE_EXTENSIONS.includes(path.extname(source.entry))) {
          queue.push(source.entry);
          queuedSource = true;
        }
      }
      for (const subpath of subpaths) {
        const specifier = `${pkg}/${subpath.subpath}`;
        decision.aliasedSpecifiers.add(specifier);
        extraAliasesOut?.push({
          find: new RegExp(`^${escapeRegex(specifier)}$`),
          replacement: subpath.entry,
        });
        queue.push(subpath.entry);
        queuedSource = true;
      }
      if (source === undefined) {
        if (!declaresEntry) {
          const types = typeof manifest?.types === "string" ? manifest.types : undefined;
          warningsOut?.push(TYPES_ONLY_WORKSPACE_PACKAGE_WARNING(pkg, types));
        } else {
          // M111 A5: the package manager invocation of the script name, with the
          // directory to run it in, never the script body.
          const buildCommand = packageScriptCommand(real, "build", process.cwd());
          const declaredEntry = manifest ? declaredRuntimeEntries(manifest)[0] : undefined;
          warningsOut?.push(
            UNBUILT_WORKSPACE_PACKAGE_NO_SOURCE_WARNING(
              pkg,
              buildCommand,
              declaredEntry && {
                field: declaredEntry.field,
                declared: declaredEntry.declared,
                exists: fs.existsSync(path.resolve(real, declaredEntry.declared)),
              },
            ),
          );
        }
      }
      for (const known of [...externalPkgs]) {
        if (pkgNameOf(known) === pkg) applyDecision(known, pkg, decision);
      }
    }
    return queuedSource;
  };

  for (;;) {
    walk();
    dropIgnored();
    if (!resolvePackages()) break;
  }

  return [...externalPkgs];
}

// M69: an entry whose two halves disagree about the wildcard produced a regex
// that could never match, so the alias was absent and nothing said so.
// M93: fires only on a genuine wildcard-count mismatch (mantine's and
// material-ui's own shapes -- one wildcard on each side, just not both
// trailing -- build a working alias instead; see buildWildcardCaptureAlias).
// The text is generated from the two counts, not a fixed claim: the old text
// ("one side has a * and the other does not") was false whenever both sides
// had exactly one, which was the shape actually blocking every mantine run.
function countStars(s: string): number {
  return (s.match(/\*/g) ?? []).length;
}

export function ALIAS_SHAPE_WARNING(pattern: string, target: string): string {
  const patternStars = countStars(pattern);
  const targetStars = countStars(target);
  const reason =
    patternStars === targetStars
      ? `both sides carry ${patternStars} wildcards, which is not a shape a single alias can express`
      : `the pattern has ${patternStars} wildcard${patternStars === 1 ? "" : "s"} and the target has ${targetStars}`;
  return (
    `tsconfig path alias "${pattern}" -> "${target}": ${reason}, so no alias was built and imports ` +
    "matching that pattern will not resolve"
  );
}

// M93: both pattern and target carry exactly one `*`, just not both as the
// whole trailing segment (mantine: pattern trailing, target mid-path;
// material-ui: pattern trailing, target extension-suffixed). Splits each on
// its `*` and builds a RegExp `find` with a capture group; Vite's alias
// replacement (@rollup/plugin-alias) substitutes `$1` from that capture the
// same way it already does for the trailing-both-sides case above. The
// target's prefix/suffix are resolved against `base` by substituting a
// private placeholder token for the `*`, running path.resolve once (so `.`/
// `..` segments and separator normalization are handled exactly as the
// trailing case already handles them), then splitting the result back apart
// on that token -- correct regardless of where in the target string the `*`
// sits. No loadable-entry check runs here, matching the trailing case: a
// wildcard alias points at a directory prefix Vite resolves per request, not
// a single module load.
const WILDCARD_ALIAS_PLACEHOLDER = "__120fpsSTAR__";

function buildWildcardCaptureAlias(
  pattern: string,
  target: string,
  base: string,
): { find: RegExp; replacement: string } {
  const [patternPrefix, patternSuffix] = pattern.split("*");
  const resolvedAbs = path
    .resolve(base, target.replace("*", WILDCARD_ALIAS_PLACEHOLDER))
    .replace(/\\/g, "/");
  const starIndex = resolvedAbs.indexOf(WILDCARD_ALIAS_PLACEHOLDER);
  const absPrefix = resolvedAbs.slice(0, starIndex);
  const absSuffix = resolvedAbs.slice(starIndex + WILDCARD_ALIAS_PLACEHOLDER.length);
  return {
    find: new RegExp(`^${escapeRegex(patternPrefix)}(.*)${escapeRegex(patternSuffix)}$`),
    replacement: `${absPrefix}$1${absSuffix}`,
  };
}

// M69: the CRA shape. With baseUrl set and no paths, a bare specifier resolves
// against baseUrl, so every top-level entry there is an alias. A name the
// project declares or has installed is left alone: node resolution owns it.
function baseUrlAliases(
  baseUrl: string,
  memberRoot: string,
  workspaceRoot: string,
): Array<{ find: RegExp; replacement: string }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseUrl, { withFileTypes: true });
  } catch {
    return [];
  }
  const aliases: Array<{ find: RegExp; replacement: string }> = [];
  const claimed = new Set<string>();
  // Files first: a file wins over a directory of the same name, as it does in
  // node resolution.
  const ordered = [...entries.filter((e) => e.isFile()), ...entries.filter((e) => e.isDirectory())];
  for (const entry of ordered) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const isDirectory = entry.isDirectory();
    const extension = path.extname(entry.name);
    if (!isDirectory && !SOURCE_EXTENSIONS.includes(extension)) continue;
    const name = isDirectory ? entry.name : entry.name.slice(0, -extension.length);
    if (!name || claimed.has(name)) continue;
    if (isPackageAvailable(name, memberRoot, workspaceRoot)) continue;
    claimed.add(name);
    aliases.push({
      // A directory also answers for everything under it; a file answers for
      // its own name alone.
      find: new RegExp(`^${escapeRegex(name)}${isDirectory ? "(?=/|$)" : "$"}`),
      replacement: path.resolve(baseUrl, entry.name).replace(/\\/g, "/"),
    });
  }
  return aliases;
}

// M76. Tags a tsconfig-`paths` alias built from the workspace root's own
// config rather than the member's: the same "attributable, not just working"
// contract WORKSPACE_ROOT_ALIAS_WARNING discloses on first use.
export interface WorkspaceRootAliasSource {
  pattern: string;
  target: string;
  configFile: string;
}

export function WORKSPACE_ROOT_ALIAS_WARNING(
  specifier: string,
  pattern: string,
  target: string,
  configFile: string,
): string {
  return (
    `import "${specifier}" resolved through the workspace root's tsconfig path alias "${pattern}" -> ` +
    `"${target}" (${configFile}), which the component's own package does not declare`
  );
}

// M77: a non-wildcard `paths` target that TypeScript resolves but that has no
// runtime entry (an @types/* stub, a .d.ts-only package) previously became an
// inert-but-present alias that crashed the harness the moment something
// imported it.
export function TYPES_ONLY_ALIAS_WARNING(pattern: string, target: string): string {
  return (
    `tsconfig path alias "${pattern}" -> "${target}" resolves to a location with no runtime entry ` +
    "(no package.json main/module/exports, no index file); the alias was skipped and " +
    `"${pattern}" resolves through normal node resolution instead`
  );
}

// True when nothing outside the key's wildcard constrains what it matches, so
// the alias fires on every root-absolute URL: "*" and "/*" do, "@/*" (prefix
// "@"), "/app/*" (prefix "app") and "*-suffix" (suffix "-suffix") do not. The
// slashes are stripped because a leading one is what a root-absolute URL is
// made of, not a constraint on the rest of the path.
function capturesEveryRootAbsoluteUrl(pattern: string): boolean {
  const first = pattern.indexOf("*");
  if (first === -1) return false;
  const bare = (part: string): string =>
    part.replace(/^\/+/, "").replace(/\/+$/, "");
  return bare(pattern.slice(0, first)) === "" && bare(pattern.slice(pattern.lastIndexOf("*") + 1)) === "";
}

// The per-entry logic shared by the member's own `paths` and, additively, the
// workspace root's (M76). M77 adds the loadable-entry check to the exact-match
// branch only: a `@/*`-style prefix aliases a directory Vite resolves per
// request, never as a single module load, so there is nothing to check there.
function buildPathAliasEntry(
  pattern: string,
  targets: readonly string[],
  base: string,
  configFile: string,
  warningsOut?: string[],
): { find: RegExp; replacement: string } | undefined {
  if (!targets.length) return undefined;
  // First target only: Vite aliases support a single replacement.
  const target = targets[0];
  // M109 (A4): a key with no prefix and no suffix of its own fires on every
  // root-absolute URL, which is Vite's client, /@fs/ and the harness entry too.
  if (capturesEveryRootAbsoluteUrl(pattern)) {
    warningsOut?.push(ROOT_ABSOLUTE_ALIAS_WARNING(pattern, target, configFile));
    return undefined;
  }
  if (pattern.endsWith("/*") && target.endsWith("/*")) {
    const prefix = pattern.slice(0, -2);
    const dir = path.resolve(base, target.slice(0, -2)).replace(/\\/g, "/");
    return { find: new RegExp(`^${escapeRegex(prefix)}/`), replacement: dir + "/" };
  }
  const patternStars = countStars(pattern);
  const targetStars = countStars(target);
  if (patternStars > 0 || targetStars > 0) {
    // M93: exactly one wildcard on each side builds a working alias via a
    // capture-group replacement, regardless of where in the target string the
    // `*` sits (mantine: mid-path; material-ui: extension-suffixed). Anything
    // else -- a genuine count mismatch, or more than one wildcard on a side
    // (TypeScript itself restricts a `paths` pattern to at most one) -- has
    // no single alias that can express it.
    if (patternStars !== 1 || targetStars !== 1) {
      warningsOut?.push(ALIAS_SHAPE_WARNING(pattern, target));
      return undefined;
    }
    return buildWildcardCaptureAlias(pattern, target, base);
  }
  const resolved = path.resolve(base, target).replace(/\\/g, "/");
  // M77: TypeScript's own module graph includes @types/* stubs and .d.ts-only
  // packages that resolve fine for the type checker but have no runtime
  // entry a bundler can load. No separate @types/ substring check is needed:
  // such a package declares none of exports/module/main and ships only
  // .d.ts files, which resolveTarget already treats as unresolvable.
  if (resolveTarget(resolved) === undefined) {
    warningsOut?.push(TYPES_ONLY_ALIAS_WARNING(pattern, target));
    return undefined;
  }
  return { find: new RegExp(`^${escapeRegex(pattern)}$`), replacement: resolved };
}

interface ParsedTsconfigPaths {
  paths?: ts.MapLike<string[]>;
  baseUrl?: string;
  base: string;
  // M95: a broken `extends` chain (nuxt-ui's `./.nuxt/tsconfig.json`, absent
  // pre-build) is a diagnostic parseJsonConfigFileContent already produces,
  // previously discarded here — only .options was ever read.
  configErrors?: string[];
}

// M95 (nuxt-ui-F1/F2). M109 moved the builder to `src/project-model.ts`, where
// the one tsconfig reader produces it; every existing importer keeps this name.
export { TSCONFIG_EXTENDS_BROKEN_WARNING };

// M109 (A4, react-spectrum-F2): react-spectrum's root declares
// `paths: { "/*": ["./*"] }`. Vite merges user aliases ahead of its own client
// alias, so the alias built from that key rewrote `/@vite/client` and the
// harness entry into the workspace root: two 404s and exit 2 before anything
// rendered. A key with no prefix of its own aliases every root-absolute URL the
// dev server owns, so it builds no alias at all.
export function ROOT_ABSOLUTE_ALIAS_WARNING(
  pattern: string,
  target: string,
  configFile: string,
): string {
  return (
    `${configFile}: the path alias "${pattern}" -> "${target}" has no prefix of its own, so it ` +
    "would rewrite every root-absolute URL the dev server serves, including Vite's own client " +
    "and the harness entry. It is skipped; the other keys in this config still apply."
  );
}

// Reads and resolves one tsconfig/jsconfig's `paths`/`baseUrl`, independent of
// which layer (member or workspace root) is asking. Returns undefined on a
// read/parse failure, after warning to stderr exactly as before M76.
function parseTsconfigPathsConfig(tsconfigPath: string): ParsedTsconfigPaths | undefined {
  const configDir = path.dirname(tsconfigPath);
  try {
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (configFile.error) {
      process.stderr.write(
        `Warning: could not parse tsconfig at ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, " ")}\n`,
      );
      return undefined;
    }
    // parseJsonConfigFileContent resolves extends (string and array), JSONC,
    // and trailing commas; baseUrl comes back absolute. M95: the full result
    // is kept (not just .options) so a broken extends target's diagnostic
    // survives instead of being discarded.
    const parsedResult = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      configDir,
      undefined,
      tsconfigPath,
    );
    const options = parsedResult.options;
    // Alias base: resolved baseUrl when set; else the directory of the config
    // that declared "paths" (pathsBasePath, internal but stable), else the
    // tsconfig's own directory.
    const base =
      options.baseUrl ?? (options as { pathsBasePath?: string }).pathsBasePath ?? configDir;
    // M95: scoped to the two diagnostic codes TypeScript actually uses for an
    // unresolvable extends target (5083 "Cannot find a base configuration
    // file", 6053 "File not found" — the latter covers an extends chain that
    // resolves one file but not a further one it itself extends). Every
    // other parseJsonConfigFileContent diagnostic is unrelated noise this
    // milestone is not about — 18003 "No inputs were found" fires for the
    // overwhelming majority of this file's own test fixtures (a tmpdir tsconfig
    // with no matching source files is a completely normal, working config),
    // and surfacing it here would be a false positive on nearly every existing
    // test, not a real defect.
    const EXTENDS_BROKEN_CODES = new Set([5083, 6053]);
    const configErrors = parsedResult.errors
      .filter((d) => EXTENDS_BROKEN_CODES.has(d.code))
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
    return {
      paths: options.paths,
      baseUrl: options.baseUrl,
      base,
      ...(configErrors.length > 0 ? { configErrors } : {}),
    };
  } catch (err) {
    process.stderr.write(
      `Warning: could not parse tsconfig at ${tsconfigPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return undefined;
  }
}

// M109 (A2): the references handover describes the run, not the caller, so it
// is disclosed once per process per config — `loadTsconfigAliases` runs several
// times in one run and the sentence is the same every time.
const disclosedGoverningConfigs = new Set<string>();

// The register spans a process, so a test process measuring several projects
// needs to start from empty; without this every assertion on a first
// disclosure depends on which test file ran first in the same worker.
export function resetGoverningDisclosures(): void {
  disclosedGoverningConfigs.clear();
}

export function loadTsconfigAliases(
  projectRoot: string,
  warningsOut?: string[],
  forFile?: string,
): Array<{ find: RegExp; replacement: string; fromWorkspaceRoot?: WorkspaceRootAliasSource }> {
  // M69: upward from the member, bounded by the root that governs the install.
  // A member inheriting the workspace tsconfig used to get no aliases at all.
  // M109 (I1): through the reader, so a references-only root hands over to the
  // referenced config that covers the file being measured.
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  const governing = resolveGoverningTsconfig(forFile ?? projectRoot, workspaceRoot);
  const tsconfigPath = governing.configPath;

  let memberAliases: Array<{ find: RegExp; replacement: string }> = [];
  let memberPatterns = new Set<string>();
  // Correction: an empty memberPatterns set means two different things — "the
  // member declared no usable config at all" (still gets the fallback) and
  // "the member declared baseUrl and deliberately no paths" (must not:
  // baseUrl-only workspace-root fallback is explicitly out of scope, "Does
  // NOT include" in the M76 spec — no finding is shaped this way, and
  // extending it without evidence would be guessing). Only the second case
  // sets this flag.
  let memberDeclaredBaseUrlOnly = false;

  // A malformed member config gives up entirely, same as before M76, rather
  // than guessing whether a root layer should still apply. The reader keeps
  // quiet about it so this message is printed once, by whoever asked.
  if (governing.nearestConfigPath && !tsconfigPath) {
    process.stderr.write(`Warning: ${governing.warnings[0]}\n`);
    return [];
  }

  if (tsconfigPath) {
    // M95: a broken extends chain (parseJsonConfigFileContent's own
    // diagnostics, previously discarded) is disclosed once per config file —
    // the rest of this function still runs on whatever paths/baseUrl it
    // could parse despite the broken part of the chain. M109: the references
    // handover travels the same channel, once per process per config.
    for (const warning of governing.warnings) {
      if (!warningsOut) break;
      if (warning.includes(TSCONFIG_REFERENCES_MARKER)) {
        if (disclosedGoverningConfigs.has(warning)) continue;
        disclosedGoverningConfigs.add(warning);
      }
      warningsOut.push(warning);
    }
    if (governing.options.paths) {
      // The member's own declared pattern names, regardless of whether its
      // own target resolves: the member deliberately owns any name it lists.
      memberPatterns = new Set(Object.keys(governing.options.paths));
      for (const [pattern, targets] of Object.entries(governing.options.paths)) {
        const entry = buildPathAliasEntry(
          pattern,
          targets,
          governing.base,
          tsconfigPath,
          warningsOut,
        );
        if (entry) memberAliases.push(entry);
      }
    } else if (governing.options.baseUrl) {
      memberAliases = baseUrlAliases(governing.options.baseUrl, projectRoot, workspaceRoot);
      memberDeclaredBaseUrlOnly = true;
    }
  }

  // M76: a second, additive layer. A single-directory probe of workspaceRoot
  // itself, not a walk (findCompilerConfig(workspaceRoot, workspaceRoot) stops
  // after one iteration either way), and only for patterns the member's own
  // config does not declare.
  const rootConfigPath = findCompilerConfig(workspaceRoot, workspaceRoot);
  const workspaceRootAliases: Array<{
    find: RegExp;
    replacement: string;
    fromWorkspaceRoot: WorkspaceRootAliasSource;
  }> = [];
  if (
    !memberDeclaredBaseUrlOnly &&
    rootConfigPath &&
    rootConfigPath !== tsconfigPath &&
    rootConfigPath !== governing.nearestConfigPath
  ) {
    const rootParsed = parseTsconfigPathsConfig(rootConfigPath);
    for (const detail of rootParsed?.configErrors ?? []) {
      warningsOut?.push(TSCONFIG_EXTENDS_BROKEN_WARNING(rootConfigPath, detail));
    }
    if (rootParsed?.paths) {
      for (const [pattern, targets] of Object.entries(rootParsed.paths)) {
        if (memberPatterns.has(pattern) || !targets.length) continue;
        const entry = buildPathAliasEntry(
          pattern,
          targets,
          rootParsed.base,
          rootConfigPath,
          warningsOut,
        );
        if (!entry) continue;
        workspaceRootAliases.push({
          ...entry,
          fromWorkspaceRoot: { pattern, target: targets[0], configFile: rootConfigPath },
        });
      }
    }
  }

  return [...memberAliases, ...workspaceRootAliases];
}

// M69: Vite serves nothing outside its allow list, and the harness root is the
// member package. An alias into a sibling package or into a linked install of
// this tool is outside it. Undefined keeps Vite's own defaults, which is every
// project whose targets are all inside the member root.
// M73: extraDirs carries directories no alias names — the component's own
// directory when its import routes through /@fs/. An empty list reproduces the
// alias-only answer exactly, undefined included.
export function fsAllowDirs(
  memberRoot: string,
  workspaceRoot: string,
  aliases: Array<{ replacement: string }>,
  extraDirs: string[] = [],
): string[] | undefined {
  const forward = (p: string) => path.resolve(p).replace(/\\/g, "/");
  const targets = aliases.map(({ replacement }) => {
    const trimmed = replacement.replace(/[\\/]+$/, "");
    if (!trimmed) return forward(replacement);
    try {
      if (fs.statSync(trimmed).isDirectory()) return forward(trimmed);
    } catch {
      // A stale alias target: its parent is the directory that would hold it.
    }
    return forward(path.dirname(trimmed));
  });

  const inside = (dir: string) => {
    const relative = path.relative(memberRoot, dir);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  const outside = [...targets, ...extraDirs.map(forward)].filter((dir) => !inside(dir));
  if (outside.length === 0) return undefined;
  return [...new Set([forward(memberRoot), forward(workspaceRoot), ...outside])];
}

export function detectScaleExport(filePath: string): boolean {
  const content = fs.readFileSync(filePath, "utf-8");
  return /export\s+(?:function|const)\s+scale\b/.test(content);
}

// M65: named after the file, listed so the message is a menu rather than a
// rejection.
export function targetNotFoundMessage(
  filePath: string,
  target: string,
  available: string[],
): string {
  const where = path.basename(filePath);
  return available.length > 0
    ? `Export "${target}" not found in ${where}. Available component exports: ${available.join(", ")}`
    : `Export "${target}" not found in ${where}, which exports no components.`;
}

// Selection order (M24 D2, M58/M65 normalization, M103/I9): explicit `#Export`
// target > default export > file-stem match among named exports after dropping
// non-alphanumerics > first PascalCase export in source order **that does not
// end in `Provider`** > first PascalCase export in source order > filename
// fallback. isDefaultOnly is true iff the chosen component is importable as a
// default import.
//
// I9 (chakra-ui-F2): a `*Provider` export is the controlled variant of the
// component beside it — it takes an externally-managed `value` object its
// uncontrolled sibling does not need, and for select/combobox that object is a
// class instance nothing can synthesize. Chakra declares it first
// (`tabs.ts:35` `TabsRootProvider` before `:52` `TabsRoot`), so source order
// alone measured the harder variant on every multi-export file. The rule is
// narrow on purpose: it re-orders the last automatic step only. An explicit
// `#Export`, a default export and a file-stem match are all the author's own
// designation of what the file is, and none of them is second-guessed — a
// `provider.tsx` whose only component is `Provider` still resolves to it.
// The rule itself is `PROVIDER_EXPORT_SUFFIX` in src/prop-gen.ts, applied by
// `selectMeasuredExport`, which this function delegates its ordering to.
export function detectComponentExport(
  filePath: string,
  target?: string,
): {
  name: string;
  isDefaultOnly: boolean;
} {
  // One SFC, one component, always the default export: there is nothing to
  // select and the file is not TypeScript, so the AST walker never runs on it.
  if (isVueFile(filePath)) {
    const name = vueComponentName(filePath);
    if (target && target !== name) throw new Error(targetNotFoundMessage(filePath, target, [name]));
    return { name, isDefaultOnly: true };
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const exports = scanExports(content, filePath);

  if (target) {
    // The pick order itself lives in `selectMeasuredExport` (src/prop-gen.ts):
    // review B-8 found two copies of it, each with its own `Provider` regex.
    // This function keeps what is its own — the "export not found" message and
    // the filename fallback — and delegates the ordering.
    if (!exports.some((e) => e.name === target)) {
      throw new Error(targetNotFoundMessage(filePath, target, exports.map((e) => e.name)));
    }
  }

  const picked = selectMeasuredExport(exports, filePath, target);
  if (picked !== undefined) {
    const info = exports.find((e) => e.name === picked)!;
    return { name: info.name, isDefaultOnly: info.isDefault };
  }

  // Fallback: derive from filename, assume default export
  const basename = path.basename(filePath, path.extname(filePath));
  const name = basename.charAt(0).toUpperCase() + basename.slice(1);
  return { name, isDefaultOnly: true };
}

function collectComponents(node: CompositionNode, set: Set<string>): void {
  if (node.component !== "__text__") set.add(node.component);
  for (const child of node.children) collectComponents(child, set);
}

function nodeToJsx(node: CompositionNode): string {
  if (node.component === "__text__") {
    return JSON.stringify(node.props.text ?? "");
  }

  const propsEntries = Object.entries(node.props);
  const propsStr = propsEntries
    .map(([k, v]) => {
      if (typeof v === "boolean") return v ? k : `${k}={false}`;
      if (typeof v === "string") return `${k}=${JSON.stringify(v)}`;
      return `${k}={${JSON.stringify(v)}}`;
    })
    .join(" ");

  const opening = propsStr ? `<${node.component} ${propsStr}>` : `<${node.component}>`;

  if (node.children.length === 0) {
    return propsStr ? `<${node.component} ${propsStr} />` : `<${node.component} />`;
  }

  const childrenJsx = node.children.map(nodeToJsx).join("\n");
  return `${opening}\n${childrenJsx}\n</${node.component}>`;
}

export function compositionToJsx(tree: CompositionTree): string {
  if (tree.structure.length === 0) return "";
  return nodeToJsx(tree.structure[0]);
}

// M106 A4 (calcom `Icon.tsx`): the entry named its bindings in the import
// statement, so one type re-exported as a value (`export { IconName, Icon }`)
// made the whole module fail to link — "does not provide an export named
// 'IconName'" — before a single line ran. A namespace import always links; the
// export is selected afterwards, by name, and a name that is not a runtime
// value is reported as exactly that instead of as a link error naming a file
// the user never asked about.
export function componentModuleImport(componentRelative: string): string {
  return `import * as __120fps_mod from "/${componentRelative}";`;
}

export function EXPORT_NOT_RUNTIME_VALUE(name: string): string {
  return `export ${name} is not a runtime value (a type-only export?)`;
}

// Emitted once per entry; `selectExport` throws at module evaluation, so the
// page error carries the name and the exports that do exist.
export function componentExportSelector(): string {
  return `const __120fps_selectExport = (name: string): any => {
  const value = name === "default" ? (__120fps_mod as any).default : (__120fps_mod as any)[name];
  if (value === undefined) {
    throw new Error(
      "export " + name + " is not a runtime value (a type-only export?); runtime exports: " +
        (Object.keys(__120fps_mod).join(", ") || "none"),
    );
  }
  return value;
};`;
}

// `scale` is optional by contract (auto-scale probes for it), so it is read,
// never selected: an absent one stays undefined and the existing
// `typeof __120fps_scale === "function"` guards decide.
export function scaleBinding(hasScale?: boolean): string {
  return hasScale ? `
const __120fps_scale = (__120fps_mod as any).scale;` : "";
}

// A namespace import alongside the default binding: a missing `viewport`
// export must not become a link-time SyntaxError in the browser.
export function wrapImportLine(wrapRelative?: string): string {
  return wrapRelative
    ? `import __120fpsWrap, * as __120fpsWrapModule from "/${wrapRelative}";\n`
    : "";
}

// `strict` is opt-in because only the measurement templates declare the strict
// bindings; the React probe entry shares this helper without them.
export function renderTreeHelper(wrapRelative?: string, strict?: boolean): string {
  const el = strict ? "__120fpsInStrict(el)" : "el";
  return wrapRelative
    ? `const renderTree = (el: any) => root.render(__120fpsWrap ? createElement(__120fpsWrap, null, ${el}) : ${el});`
    : `const renderTree = (el: any) => root.render(${el});`;
}

// StrictMode nests inside the provider wrapper, so the double-invoke cost
// measured is the component's and not the providers'. Named __120fpsInStrict,
// not __120fpsWrapStrict: an entry without a wrapper must not mention
// __120fpsWrap at all.
export function strictBlock(): string {
  return `const __120fpsStrict = new URLSearchParams(location.search).get("strict") === "1";
const __120fpsInStrict = (el: any) => __120fpsStrict ? createElement(StrictMode, null, el) : el;`;
}

// M44. Functions and JSX cannot cross the CDP boundary, so combo generation
// carries their position instead and the entry substitutes the real value at
// render time. Literal preset values never become refs: they travel as
// themselves, so deltas and matrix cells compare real data.
export function presetImportLine(presetRelative?: string): string {
  return presetRelative
    ? `import __120fpsPresets from "/${presetRelative}";\n`
    : "";
}

export function presetResolverBlock(presetRelative?: string): string {
  if (!presetRelative) return "";
  return `
const __120fpsResolveProps = (props: any) => {
  const out: any = { ...props };
  for (const key of Object.keys(out)) {
    const value = out[key];
    if (value && typeof value === "object" && "__120fps_preset" in value) {
      const pool = (__120fpsPresets as any)[value.__120fps_preset];
      out[key] = Array.isArray(pool) ? pool[value.index] : pool;
    }
  }
  return out;
};
`;
}

// Substituted once at each entry point rather than at every render site, so
// scale fan-outs and composed scenes get resolved props without extra cases.
export function presetResolveStatement(presetRelative?: string): string {
  return presetRelative ? "props = __120fpsResolveProps(props);" : "";
}

// M41. Bounded because an unbounded setup would surface as a bare readiness
// timeout 30s later, naming the harness instead of the wrapper.
export const WRAPPER_SETUP_TIMEOUT_MS = 15000;

// Top-level await ahead of the control API assignment: readiness implies setup
// completed, so a fetch mock is installed before the first render. A rejection
// fails module evaluation, which reaches the run as a captured page error.
export function setupBlock(wrapRelative?: string): string {
  if (!wrapRelative) return "";
  return `
const __120fpsSetup = (__120fpsWrapModule as any).setup;
if (typeof __120fpsSetup === "function") {
  await Promise.race([
    Promise.resolve(__120fpsSetup()),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("120fps: wrapper setup did not finish within ${WRAPPER_SETUP_TIMEOUT_MS}ms")),
        ${WRAPPER_SETUP_TIMEOUT_MS},
      ),
    ),
  ]);
}
`;
}

// Session-scoped, not per-unmount: setup runs once and later samples depend on
// what it installed, so tearing it down between samples would dismantle the
// mocks the measurement needs. Measurement sessions call this before disposing.
export function setupApiBlock(wrapRelative?: string): string {
  if (!wrapRelative) return "";
  return `
(window as any).__120fps.hasSetup = typeof __120fpsSetup === "function";
(window as any).__120fps.teardown = async () => {
  const __120fpsTeardown = (__120fpsWrapModule as any).teardown;
  if (typeof __120fpsTeardown === "function") await __120fpsTeardown();
};
`;
}

// M102 (I7, excalidraw-F2). `Stylesheets: css/styles.scss` plus `Result: PASS`
// read as "a styled button was measured" when every rule in that file is nested
// under a `.excalidraw` ancestor the harness never renders, so not one of them
// could match. Efficacy is a runtime question and CSSOM has already parsed the
// answer: rules with a `selectorText`, tested against the rendered tree. No CSS
// parser and no preprocessor (M82's non-goals), no network, and every sheet and
// selector is guarded on its own — a cross-origin sheet throws on `cssRules`, an
// exotic selector throws in `querySelector`, and neither may take the run down.
export const STYLESHEET_MATCH_STATS_SOURCE = `function __120fpsStylesheetMatchStats(specifiers, doc, root) {
  var countRules = function (list, stats) {
    for (var i = 0; i < list.length; i++) {
      var rule = list[i];
      if (rule.selectorText) {
        stats.rules++;
        // Review I7: a rule is matched when ANY of its comma-separated parts
        // matches. A part scoped to the document itself (:root, html, body, *)
        // can never be found under #root by querySelector, yet a design-token
        // sheet made of :root custom properties is exactly the kind that does
        // apply — counting it as unmatched said "unstyled" about a stylesheet
        // the render used.
        var parts = String(rule.selectorText).split(",");
        for (var p = 0; p < parts.length; p++) {
          var part = parts[p].trim();
          if (!part) continue;
          if (/^(:root|html|body|\\*)([^a-zA-Z0-9_-]|$)/.test(part)) {
            stats.matched++;
            break;
          }
          try {
            if (root && (root.querySelector(part) || (root.matches && root.matches(part)))) {
              stats.matched++;
              break;
            }
          } catch (selectorError) {
            // A part querySelector rejects matched nothing here either.
          }
        }
      } else if (rule.cssRules) {
        countRules(Array.prototype.slice.call(rule.cssRules), stats);
      }
    }
  };
  var out = [];
  var sheets = Array.prototype.slice.call((doc && doc.styleSheets) || []);
  for (var s = 0; s < specifiers.length; s++) {
    var specifier = specifiers[s];
    var wanted = specifier.indexOf("/@fs/") === 0 ? specifier.slice(5) : specifier.replace(/^\\//, "");
    var stats = { file: wanted, rules: 0, matched: 0 };
    for (var i = 0; i < sheets.length; i++) {
      var node = sheets[i].ownerNode;
      var id = node && node.getAttribute
        ? node.getAttribute("data-vite-dev-id") || node.getAttribute("href") || ""
        : "";
      id = String(id).replace(/\\\\/g, "/").split("?")[0];
      if (!wanted || id.slice(-wanted.length) !== wanted) continue;
      var rules;
      try {
        rules = sheets[i].cssRules;
      } catch (readError) {
        continue;
      }
      countRules(Array.prototype.slice.call(rules || []), stats);
    }
    out.push(stats);
  }
  return out;
}`;

export function stylesheetMatchStatsBlock(cssImports?: string[]): string {
  if (!cssImports || cssImports.length === 0) return "";
  return `
${STYLESHEET_MATCH_STATS_SOURCE}
(window as any).__120fps.stylesheetMatchStats = () =>
  __120fpsStylesheetMatchStats(${JSON.stringify(cssImports)}, document, document.getElementById("root"));
`;
}

function viewportBlock(wrapRelative?: string): string {
  if (!wrapRelative) return "";
  return `
const __120fpsViewport = (__120fpsWrapModule as any).viewport;
if (__120fpsViewport) (window as any).__120fps.viewport = __120fpsViewport;
`;
}

export interface EntryOptions {
  componentRelative: string;
  componentName: string;
  isDefaultExport: boolean;
  hasScale: boolean;
  wrapRelative?: string;
  cssImports?: string[];
  presetRelative?: string;
  // Defaults to React, so every existing caller produces the entry it did before.
  renderer?: Renderer;
  // M87: true when the SFC's template root carries none of v-if/v-show/v-for
  // (templateHasUnconditionalRoot, src/vue-sfc.ts). Only that shape is safe to
  // force into a stable wrapped render in the combo phase: a conditional root
  // must keep the ability to legitimately report zero DOM.
  vueUnconditionalRoot?: boolean;
}

// The renderer supplies four things: the import block, the mount body, the
// unmount body, and `renderTree`. Everything around them: the M25 stylesheet
// block, the M41 setup/teardown blocks, the M44 preset resolver, the M26
// single-render-site rule: is renderer-independent and shared.
export function generateEntry(opts: EntryOptions): string {
  return opts.renderer === "vue" ? generateVueEntry(opts) : generateReactEntry(opts);
}

// Vue batches updates into a microtask queue drained on nextTick(), so the
// control API awaits it before resolving `rerender`. Resolving earlier would
// time scheduling a rerender rather than performing one, and the caller's
// double-rAF fence proves a frame was presented, not that the queue drained
// into it: a wrong answer here reports implausibly fast rerenders instead of
// failing.
export function generateVueEntry(opts: EntryOptions): string {
  const {
    componentRelative,
    componentName,
    hasScale,
    wrapRelative,
    cssImports,
    presetRelative,
    vueUnconditionalRoot,
  } = opts;

  // M106 A4: namespace import, runtime selection — see componentModuleImport.
  // An SFC always exports its component as the default (detectComponentExport
  // returns isDefaultOnly for every .vue file), so the selected name is fixed.
  const importLine =
    componentModuleImport(componentRelative) +
    `
${componentExportSelector()}
const ${componentName} = __120fps_selectExport("default");` +
    scaleBinding(hasScale);

  // Auto-scale fans N instances out inside one element, wrapped once (M26).
  const scaleBranch = hasScale
    ? `  if (typeof props.__120fps_scaleN === "number" && typeof __120fps_scale === "function") {
    return __120fps_scale(props.__120fps_scaleN);
  }`
    : `  if (typeof props.__120fps_scaleN === "number") {
    const { __120fps_scaleN: _n, ...rest } = props;
    return h("div", null, Array.from({ length: props.__120fps_scaleN }, (_, i) =>
      h(${componentName}, { ...rest, key: i })));
  }`;

  // M87 (primevue's Accordion.vue): a component reading `this.$slots.default()`
  // or `slots.default?.()` as a callable needs `$slots.default` to exist and be
  // a function whether or not real children were composed in -- with no third
  // h() argument at all, $slots.default is undefined, and calling it throws.
  // An always-present, empty-returning default slot changes nothing for a
  // component that never inspects $slots.
  const defaultSlotsArg = `, { default: () => [] }`;
  // M87 (element-plus's button.vue): a template whose root has no v-if/v-show/
  // v-for always produces a real root element once mounted for real. Wrapping
  // the bare render in the same stable container shape scale-probe already
  // uses (its own scale branch above) is what makes the combo phase agree
  // with scale-probe's already-correct nonzero count. A conditional root is
  // left bare so a legitimately empty render can still report zero DOM.
  const bareRender = `h(${componentName}, { ...props }${defaultSlotsArg})`;
  const rootRender = vueUnconditionalRoot ? `h("div", null, [${bareRender}])` : bareRender;

  return `
${cssImportBlock(cssImports)}import { createApp, h, nextTick, shallowRef } from "vue";
${wrapImportLine(wrapRelative)}${presetImportLine(presetRelative)}${importLine}

const container = document.getElementById("root")!;
// A plain object per render, out of a shallowRef: the component sees the same
// unproxied props a parent would hand it, and a new identity patches the child
// instead of remounting it.
const propsRef = shallowRef<any>({});
let app: any = null;
let mounted = false;
let wrapperOnly = false;

const renderComponent = () => {
  const props = propsRef.value;
${scaleBranch}
  return ${rootRender};
};
${vueRenderTreeHelper(wrapRelative)}
const __120fpsRoot = { render: () => renderTree(wrapperOnly ? null : renderComponent()) };

const startApp = () => {
  app = createApp(__120fpsRoot);
  app.mount(container);
  mounted = true;
};
const stopApp = () => {
  if (mounted) {
    app.unmount();
    app = null;
    mounted = false;
  }
};
${presetResolverBlock(presetRelative)}${setupBlock(wrapRelative)}
(window as any).__120fps = {
  mount(props: any = {}) {
    ${presetResolveStatement(presetRelative)}
    stopApp();
    wrapperOnly = false;
    propsRef.value = props;
    startApp();
  },
  mountWrapperOnly() {
    stopApp();
    wrapperOnly = true;
    propsRef.value = {};
    startApp();
  },
  unmount() {
    stopApp();
  },
  async rerender(props: any = {}) {
    ${presetResolveStatement(presetRelative)}
    propsRef.value = props;
    await nextTick();
  },
  getContainer() {
    return container;
  },
};
${setupApiBlock(wrapRelative)}${viewportBlock(wrapRelative)}${stylesheetMatchStatsBlock(cssImports)}
`;
}

// The default slot keeps the wrapper outside the component exactly as
// createElement(wrap, null, el) does on the React path.
export function vueRenderTreeHelper(wrapRelative?: string): string {
  return wrapRelative
    ? `const renderTree = (node: any) => __120fpsWrap ? h(__120fpsWrap, null, { default: () => node }) : node;`
    : `const renderTree = (node: any) => node;`;
}

function generateReactEntry(opts: EntryOptions): string {
  const { componentRelative, componentName, isDefaultExport, hasScale, wrapRelative, cssImports, presetRelative } = opts;

  // M106 A4: namespace import, runtime selection — see componentModuleImport.
  const componentRef = isDefaultExport ? componentName : "Component";
  const importLine =
    componentModuleImport(componentRelative) +
    `
${componentExportSelector()}
const ${componentRef} = __120fps_selectExport(` +
    `${JSON.stringify(isDefaultExport ? "default" : componentName)});` +
    scaleBinding(hasScale);

  const autoScaleRender = `if (typeof props.__120fps_scaleN === "number") {
      const n = props.__120fps_scaleN;
      const { __120fps_scaleN: _, ...restProps } = props;
      renderTree(createElement("div", null,
        ...Array.from({ length: n }, (_, i) => createElement(${componentRef}, { ...restProps, key: i }))
      ));
    } else {
      renderTree(createElement(${componentRef}, props));
    }`;

  const render = hasScale
    ? `if (typeof props.__120fps_scaleN === "number" && typeof __120fps_scale === "function") {
      renderTree(__120fps_scale(props.__120fps_scaleN));
    } else {
      renderTree(createElement(${componentRef}, props));
    }`
    : autoScaleRender;

  return `
${cssImportBlock(cssImports)}import { createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
${wrapImportLine(wrapRelative)}${presetImportLine(presetRelative)}${importLine}

const container = document.getElementById("root")!;
let root = createRoot(container);
let mounted = false;
${strictBlock()}
${renderTreeHelper(wrapRelative, true)}
${presetResolverBlock(presetRelative)}${setupBlock(wrapRelative)}
(window as any).__120fps = {
  mount(props: any = {}) {
    ${presetResolveStatement(presetRelative)}
    if (mounted) {
      root.unmount();
      root = createRoot(container);
    }
    ${render}
    mounted = true;
  },
  mountWrapperOnly() {
    if (mounted) {
      root.unmount();
      root = createRoot(container);
    }
    renderTree(null);
    mounted = true;
  },
  unmount() {
    if (mounted) {
      root.unmount();
      root = createRoot(container);
      mounted = false;
    }
  },
  rerender(props: any = {}) {
    ${presetResolveStatement(presetRelative)}
    ${render}
  },
  getContainer() {
    return container;
  },
};
${setupApiBlock(wrapRelative)}${viewportBlock(wrapRelative)}${stylesheetMatchStatsBlock(cssImports)}
`;
}

export function generateComposedEntry(
  componentRelative: string,
  tree: CompositionTree,
  exports?: ExportInfo[],
  wrapRelative?: string,
  cssImports?: string[],
): string {
  const components = new Set<string>();
  for (const node of tree.structure) collectComponents(node, components);

  const defaultExports = new Set(exports?.filter((e) => e.isDefault).map((e) => e.name) ?? []);
  const namedImports = [...components].filter((n) => !defaultExports.has(n)).sort();
  const defaultImport = [...components].find((n) => defaultExports.has(n));

  // M106 A4: one namespace import for the whole composed scene; every composed
  // name keeps its own binding, selected by name at runtime.
  const bindings = [
    ...(defaultImport ? [`const ${defaultImport} = __120fps_selectExport("default");`] : []),
    ...namedImports.map((name) => `const ${name} = __120fps_selectExport(${JSON.stringify(name)});`),
  ];
  const importLine = [
    componentModuleImport(componentRelative),
    componentExportSelector(),
    ...bindings,
  ].join("\n");
  const jsx = compositionToJsx(tree);

  return `
${cssImportBlock(cssImports)}import { createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
${wrapImportLine(wrapRelative)}${importLine}

const ComposedScene = () => (
${jsx}
);

const container = document.getElementById("root")!;
let root = createRoot(container);
let mounted = false;
${strictBlock()}
${renderTreeHelper(wrapRelative, true)}
${setupBlock(wrapRelative)}
(window as any).__120fps = {
  mount(props: any = {}) {
    if (mounted) {
      root.unmount();
      root = createRoot(container);
    }
    renderTree(<ComposedScene {...props} />);
    mounted = true;
  },
  mountWrapperOnly() {
    if (mounted) {
      root.unmount();
      root = createRoot(container);
    }
    renderTree(null);
    mounted = true;
  },
  unmount() {
    if (mounted) {
      root.unmount();
      root = createRoot(container);
      mounted = false;
    }
  },
  rerender(props: any = {}) {
    renderTree(<ComposedScene {...props} />);
  },
  getContainer() {
    return container;
  },
};
${setupApiBlock(wrapRelative)}${viewportBlock(wrapRelative)}${stylesheetMatchStatsBlock(cssImports)}
`;
}
