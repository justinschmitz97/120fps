---
kind: milestone
status: draft
tests:
  - test/unit/bundler-error-presentation.test.ts
  - test/unit/unbuilt-workspace-source-alias.test.ts
---

# M94: bundler failures surface as 120fps errors

## Purpose

Four repositories surface multi-frame Vite/PostCSS traces containing 120fps's own `node_modules`
paths. shadcn-ui is the worst case: `npx 120fps ./button.tsx` on shadcn's own button emits ten frames
of PostCSS internals over an absent `shadcn/tailwind.css`, and a separate candidate emits eight
frames of Vite internals over an absent `dist/` subpath export. dub is sharper still: the tool emits
a warning saying an import was "excluded from the pre-bundle" and then crashes on that same import —
the warning is lying, because excluding a genuinely runtime-used import from `optimizeDeps.include`
only prevents the *optimizer's* eager resolution; it does nothing to stop Vite's own per-request
resolution from failing identically the moment the browser actually loads the importing file.

## Contract

### MUST

- A Vite, PostCSS, or esbuild failure is caught and re-presented as a 120fps error naming the
  unresolvable target, the importer that reached it, and a remedy.
- No error printed to the user contains a path inside 120fps's own installation.
- A warning claiming an import was excluded is true: that import does not subsequently reach the
  bundler.

### MUST NOT

- Print a raw bundler stack trace.

## Design

Two independent fixes, both inside `buildAndServe`'s `bootServer()` catch and `scanExternalDeps`
(`src/harness.ts`).

**Presentation.** `stripBundlerStackFrames` removes every line matching a stack-frame shape (`^\s*at
\S`) from a caught error's message before it is ever assembled into `VITE_START_FAILED`'s detail —
unconditional, so it holds even for a shape no specific diagnosis below recognizes. `diagnoseBundlerFailure`
recognizes two concrete repro shapes ahead of that stripping and replaces the whole message with a
named, remedied one: Vite's `Failed to resolve import "X" from "Y". Does the file exist?` (shadcn's
`@shadcn/react/message-scroller` case) becomes a 120fps error naming the importer and the
unresolvable specifier; PostCSS's `[postcss] ENOENT: no such file or directory, open '<path>'`
(shadcn's `tailwind.css` case) becomes one naming the missing stylesheet and pointing at `--no-css`
or building the source package. Both existing diagnosis functions in this catch —
`diagnoseUnbuiltWorkspacePackage` (M79) first, then this milestone's `diagnoseBundlerFailure` — are
tried in order; whichever recognizes the shape wins, and an unrecognized message still gets its stack
frames stripped as the universal fallback, so the MUST NOT holds unconditionally, not only for the
two shapes with bespoke wording.

**Honesty.** `scanExternalDeps`'s M77 exclusion loop (the mechanism `TYPE_ONLY_PACKAGE_WARNING`
reads from) previously treated "a bare specifier resolves to an installed package with no runtime
entry" as proof of type-only usage, unconditionally. dub's `@dub/utils` is imported bare
(`import { cn } from "@dub/utils"`), is a workspace sibling whose `package.json` `main` points at an
unbuilt `dist/`, and is genuinely used as a value at runtime — excluding it from `optimizeDeps.include`
does not stop Vite's own module transform from trying (and failing) to resolve the same bare
specifier the moment the browser loads the file that imports it, which is exactly what crashed the
harness right after printing the "excluded" warning.

The loop now branches on whether the package is a workspace sibling (`isWorkspaceSibling`, already
used by the sibling-subpath-substitution logic M76 added) before concluding type-only. When it is,
and its own `src/` directory has a resolvable entry (`resolveTarget`, the same primitive already
used everywhere else in this file), the package is not excluded at all: it is aliased to that source
directory instead (`{ find: ^pkg$, replacement: src-entry }`), pushed into the same alias array the
harness's Vite config already builds from, with `UNBUILT_WORKSPACE_SOURCE_ALIAS_WARNING` naming both
the package and the source path that now answers for it — Vite's per-request resolution succeeds too,
because the alias applies universally, not only inside `optimizeDeps`. `scanExternalDeps` gains a
trailing `extraAliasesOut` output parameter for this; its one call site (`buildAndServe`) passes the
same `alias` array already being built, appending to it before `createServer()` reads it, so no new
plumbing beyond one extra push target is needed.

When the workspace sibling has no resolvable source either, the exclusion still happens (nothing else
is safe to do), but the warning changes: `UNBUILT_WORKSPACE_PACKAGE_NO_SOURCE_WARNING` says the
import may still fail when the browser loads it — not the unconditional "instead of aborting the
harness" promise the original M77 wording made — and names the package's own `scripts.build` command
when its `package.json` declares one. A genuinely external, non-workspace package with no runtime
entry (`csstype`, `@graphql-typed-document-node/core`, the two real M77 closes) is unaffected:
`isWorkspaceSibling` is false for both, so they keep today's `TYPE_ONLY_PACKAGE_WARNING` path and
today's wording, which remains accurate for a genuinely type-only import whose statement TypeScript
itself erases before the browser ever sees it.

## Open questions

None.

## Verification

- A fixture Vite `"Failed to resolve import ... Does the file exist?"` error with embedded
  `node_modules/.pnpm/vite@...` stack frames: the re-presented message names the target and importer,
  offers a remedy, and contains no `node_modules` substring.
- A fixture PostCSS `[postcss] ENOENT` error with embedded stack frames: same shape, naming the
  missing stylesheet.
- An unrecognized bundler error with embedded stack frames: frames are stripped, the original
  descriptive text is preserved.
- A workspace-sibling package imported bare, unbuilt `dist/`, resolvable `src/index.*`: aliased to
  source, not excluded; the resulting alias resolves the specifier; `UNBUILT_WORKSPACE_SOURCE_ALIAS_WARNING`
  names both.
- The same shape with no resolvable `src/`: still excluded, `UNBUILT_WORKSPACE_PACKAGE_NO_SOURCE_WARNING`
  fires instead of the old unconditional "excluded... instead of aborting" text, naming the build
  command when `package.json` declares one.
- A genuinely external type-only package (`csstype`-shaped fixture, not a workspace sibling): unaffected,
  `TYPE_ONLY_PACKAGE_WARNING` fires exactly as before M94.
- `test/unit/tsconfig-aliases.test.ts` and the M76/M77 import-scanner suites stay green.
