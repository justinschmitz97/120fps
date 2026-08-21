---
kind: milestone
status: draft
tests:
  - test/unit/shim-export-surface.test.ts
  - test/unit/m95-m96-followup.test.ts
---

# M96: Bundled shims match their real module surface

## Purpose

cal.com's `DatePicker` hard-fails at build because 120fps's own `dist/shims/next-navigation.js` is
missing the `ReadonlyURLSearchParams` export that `useCompatSearchParams.tsx:3` imports as a real
(non-type-only) value. This is a defect in the tool's own code, not in the target repository — a
component doing nothing unusual crashes because 120fps's stand-in for a module it replaces is
incomplete.

Closes: calcom-F2.

## Contract

### MUST

- Every shim (`src/shims/*.ts`) exports every named export the module it replaces is documented to
  provide, for the App Router / Pages Router API surface 120fps's existing shim set already targets
  (Next.js 13-15+: `next/navigation`, `next/router`, `next/headers`, `next/image`, `next/link`,
  `next/head`, `next/script`, `next/dynamic`, `next/font/local`; `next-video/player` against its own
  package API, not Next.js's).
- A component importing a named export a shim does not provide gets an error naming the shim, the
  missing export, and `--no-shims`.

### Invariants

- No shim's existing export signature changes shape for a caller already relying on it: this
  milestone only adds exports, it does not alter what an already-supported import does.
- A shim's runtime behavior stays inert for measurement purposes (no network request, no real
  navigation, no real font/script load) — matching every existing shim's own documented rationale.

## Design

Audited against each real module's current public API (`src/shims/*.ts`, one file per shimmed
module):

- **`next-navigation.ts`**: adds `ReadonlyURLSearchParams` (a real runtime `class`, not a type alias
  — calcom's import is a value import, and `useSearchParams()` now constructs one, matching real
  Next.js's own implementation of returning a read-only `URLSearchParams` subclass whose mutating
  methods throw), `permanentRedirect`, `RedirectType`, `useSelectedLayoutSegment`,
  `useSelectedLayoutSegments`, `unstable_rethrow`.
- **`next-headers.ts`**: adds `draftMode`, matching the existing file's synchronous convention (its
  sibling `cookies`/`headers` are not wrapped in a Promise; making only the new export async would be
  an inconsistent, undocumented API shape within the same file).
- **`next-image.ts`**: adds `getImageProps`, reusing the same prop-stripping logic the `Image`
  component already applies.
- **`next-router.ts`**, **`next-link.ts`**, **`next-script.ts`**, **`next-dynamic.ts`**,
  **`next-font-local.ts`**, **`next-head.ts`**: audited, no runtime-value gap found against the
  current public API of each.

The second contract item is implemented in `src/harness.ts` (Lane A), not this lane's `src/shims/`:
a named import that resolves to nothing a shim exports fails at the ES module static-resolution
level (esbuild's own `No matching export in "<file>" for import "<name>"` error) before any of the
shim's own code runs, so only the bundler-error layer `buildAndServe`'s `bootServer()` catch already
owns (M94's `diagnoseBundlerFailure` chain) can catch and re-present it. `diagnoseMissingShimExport`
matches the file esbuild names against the exact absolute path `buildShimAliases` would itself have
aliased a shimmed specifier to (not a loose basename guess, so an unrelated same-named file in the
target repository is never misattributed), and replaces the message with one naming the shim's public
specifier (`next/navigation`, not the absolute `dist/shims/next-navigation.js` path esbuild's own
message contains — a path inside 120fps's own installation, which M94's own MUST NOT already forbids
printing), the missing export, and `--no-shims`.

## Open questions

None.

## Verification

- A test enumerating each shim's actual exported names against a hand-maintained list of the real
  module's documented public API for the version range above (one assertion per shim file).
- A fixture importing `ReadonlyURLSearchParams` as a value from `next/navigation` and using it (e.g.
  `useSearchParams() instanceof ReadonlyURLSearchParams`) builds and mounts without a bundler error.
- `useSearchParams()`'s returned instance rejects a mutation (`.set(...)` throws), matching real
  Next.js's read-only contract.
- A synthetic esbuild `No matching export in "<dist/shims/next-navigation.js path>" for import
  "<name>"` error, matched against `buildShimAliases`' own computed shim path: re-presented naming
  the shim's public specifier, the missing export, and `--no-shims`, with no `dist/shims/` path or
  other 120fps-install path anywhere in the message (`test/unit/m95-m96-followup.test.ts`).
