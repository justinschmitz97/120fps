---
kind: milestone
status: approved
tests:
  - test/unit/harness-dir-writability.test.ts
  - test/unit/react-version-boot-gate.test.ts
  - test/unit/cross-drive-import-specifiers.test.ts
  - test/unit/next-runtime-shim-coverage.test.ts
  - test/unit/isolation-phase-warnings.test.ts
---

# M73: harness boot guardrails and Next shim coverage

## Goal

Every remaining portability failure in `buildAndServe` surfaces as somebody else's error message. A read-only project root fails with a raw `EACCES` from `mkdtempSync`, a React 17 project fails with an esbuild resolution dump for `react-dom/client`, and a cross-drive `--wrap` path passes the "must live inside the project root" guard and then emits an import specifier that names a directory which does not exist. Each one is a setup fact the harness can state in one sentence before it boots Vite.

The Next.js shim table stops at six modules, and the seventh import in a real app (`next/script`, `next/head`, `next/router`, `next/font/local`) resolves against the project's own Next install, where a module written for the Next server or its compiler plugin fails to load in a plain browser. Anything else under `next/*` gets named in a warning rather than failing silently as "the component just does not render".

Two residuals close with it: font-settle warnings raised inside isolation phases were dropped on the floor (M70), and `detectPnP` was never re-exported from the package entry (M72).

## Scope

### 1. Harness directory writability (`src/harness.ts`, `createHarnessDir`, `HARNESS_DIR_UNWRITABLE`)

`buildAndServe` placed the generated entry with `fs.mkdtempSync(path.join(projectRoot, ".120fps-harness-"))` and no preflight (`src/harness.ts`, `mkdtempSync` call site). In-root placement is not negotiable: Vite's `root` is the project root and every alias, every `node_modules` walk, and every root-absolute specifier in the generated entry resolves from it. A read-only root is therefore a refusal, not a fallback, and the milestone's job is to say so.

- `createHarnessDir(projectRoot)` preflights with `fs.accessSync(projectRoot, fs.constants.W_OK)` and then creates the directory. Both steps are wrapped: `accessSync` answers POSIX permission bits, and the real `mkdtempSync` answers everything `accessSync` cannot see (Windows ACLs, a read-only mount, a root that is a file, a root that does not exist).
- Any failure throws `HARNESS_DIR_UNWRITABLE(projectRoot, detail)`, which names the directory, carries the underlying message as the detail, states that 120fps writes its entry inside the project root so the project's own aliases and `node_modules` resolve the way the app resolves them, and gives the two ways out (make it writable, or copy the project somewhere writable). `cause` carries the original error.
- Same dedicated-message pattern as `VITE_START_FAILED` and `VUE_COMPILER_MISSING`: an exported constant function, thrown before anything is created.

### 2. React 18 boot gate (`src/harness.ts`, `assertReactDomClient`, `REACT_DOM_CLIENT_MISSING`)

`rendererDeps` forced `"react-dom/client"` into `optimizeDeps.include` for every React project with no existence check, while `reactJsxRuntimeDeps` and `reactCompilerRuntimeDeps` right beside it already resolve defensively. On React 16 or 17 the include list aborts Vite's optimizer with an esbuild resolution error naming a path inside the dep cache.

- Before the server boots, a React run resolves `react-dom/client` from the project (`createRequire(projectRoot)`).
- Resolution failure reads the project's `react-dom` version from its own `package.json` and throws `REACT_DOM_CLIENT_MISSING(projectRoot, version)`: `React 18+ required (found react-dom vX)` when the version is readable, and the same message without the parenthetical when it is not. The message names the reason (the harness mounts with `createRoot` from `react-dom/client`, which React 16 and 17 do not have) and the fix.
- Vue runs never resolve React and never see the gate.
- The version read is local to `src/harness.ts`: `src/react-profiler.ts` imports values from `src/harness.ts`, so the reverse import would close a module cycle.

### 3. Cross-drive paths (`src/harness.ts`, `isOutsideRoot`, `componentImportPath`, `resolveWrapper`, `fsAllowDirs`)

`path.win32.relative("C:\\proj", "D:\\x\\Button.tsx")` returns `D:\x\Button.tsx`: an absolute path with no `..` prefix, because two Windows drives have no common ancestor to walk up to. Two sites read that result as if it were relative.

- `isOutsideRoot(target, root, platform = path)` is the single predicate: true when the relative form is `..`, starts with `..` plus a separator, or is absolute. The `platform` parameter takes `path.win32` or `path.posix` so the behavior is testable on any host.
- `componentImportPath(componentPath, projectRoot, platform = path)` returns the body of the entry's import specifier, the value the generators embed as `from "/${componentRelative}"`. In-root it is the forward-slashed relative path, unchanged from today. Out of root it is `@fs/<posix-absolute>`, so the specifier becomes `/@fs/D:/x/Button.tsx`: Vite's escape hatch for files outside the root, and exactly the form `cssImportSpecifier` already emits for an out-of-root stylesheet.
- `resolveWrapper` checked `relative.startsWith("../")` on an already forward-slashed string, which a cross-drive wrapper passes. It now uses `isOutsideRoot` on the raw relative path and throws its existing "must live inside the project root" error. This is the reachable half: `--wrap` takes any path from the command line.
- `fsAllowDirs` gains a fourth parameter, `extraDirs` (default `[]`), filtered by the same inside/outside test as the alias targets. `buildAndServe` passes the component's directory when the `/@fs/` form engages, because Vite serves nothing outside its allow list. An empty `extraDirs` reproduces today's answer exactly, including `undefined` for a project whose alias targets are all in root.

### 4. Next.js shim coverage (`src/harness.ts` `SHIM_MODULES`, `src/shims/*`)

Four modules join the table, each a standalone-renderable stand-in in the style and size of the existing six:

| module | shim | behavior |
| --- | --- | --- |
| `next/script` | `next-script.ts` | renders `null`. A real `<script>` would fetch and execute third-party code inside the measured window. |
| `next/head` | `next-head.ts` | renders `null`. Its children are document metadata; rendering them inline would put `<title>`/`<meta>` in the body and move the layout. |
| `next/router` | `next-router.ts` | pages-router `useRouter` returning inert stubs (`push`/`replace`/`back`/`forward`/`reload`/`prefetch`, `pathname`, `route`, `query`, `asPath`, `basePath`, `isReady`, `isFallback`, `events`), plus `withRouter` and the singleton default export. Mirrors `next-navigation.ts`. |
| `next/font/local` | `next-font-local.ts` | default-exports a function returning `{ className: "", variable: "", style: {} }`. |

`next/font/google` is **not** shimmed, and the reason is a hard constraint rather than a choice: each font family is a separate named export (`import { Inter } from "next/font/google"`), the set of families is unbounded, and a browser rejects a named import that its target ESM module does not export. A static shim file would link-error for every family it did not happen to list, which is worse than the module being absent. It is warned about like any other unshimmed `next/*` module.

Unshimmed `next/*` (`UNSUPPORTED_NEXT_MODULE_WARNING`): in a Next project, every scanned specifier starting with `next/` that no shim answers is collected, sorted, and named in one warning on the existing `HarnessResult.warnings` channel. It never blocks a run: the module still resolves from the project, and it may well work.

### 5. Font-settle warnings from isolation phases (`src/isolation.ts`)

`measureChurn`, `measureMemory`, and `measureStrictMode` call `runHarnessSession` without `onWarning`, so `reportFontSettle` (M70) had nowhere to deliver `FONT_SETTLE_WARNING` in an `--isolate` run. `PhaseOptions` and `IsolationRunOptions` gain `onWarning?`, `runIsolationPhases` forwards it to all five measurement calls (mount and rerender already accept one), and `runIsolationMode` in `src/analyze.ts` passes `ctx.onWarning`, the same sink every other phase uses.

### 6. `detectPnP` export (`src/index.ts`)

Added to the `./project-model.js` export block beside its siblings.

## Does NOT include

- Server-component emulation. Nothing here runs a React server renderer or resolves a server/client boundary.
- `next/cache` (`revalidatePath`, `unstable_cache`, `revalidateTag`): server-only APIs with no client-side behavior to stand in for. It warns like any other unshimmed `next/*` module.
- `next/font/google`, for the named-export reason above.
- Remix and Gatsby shims. The shim table stays Next-shaped; another framework's runtime is its own milestone.
- Rewriting the project's imports. The `/@fs/` routing covers the entry the harness generates, not the project's own module graph.

## Acceptance criteria

- A project root that cannot be written to fails with a message naming the directory and the in-root requirement, before any harness file exists.
- A React project without `react-dom/client` fails with a message naming the required React version and the found `react-dom` version, before Vite boots.
- A component or wrapper path on another Windows drive is out of root: the wrapper is rejected with the existing error, and the component's specifier routes through `/@fs/` with its directory added to `server.fs.allow`.
- `next/script`, `next/head`, `next/router`, and `next/font/local` are shimmed and emitted to `dist/shims/`.
- An unshimmed `next/*` import in a Next project produces exactly one warning naming it, and the run continues.
- Font-settle warnings raised in an isolated churn, memory, or strictmode phase reach the run's warning sink.
