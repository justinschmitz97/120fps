---
kind: milestone
status: approved
tests:
  - test/unit/cli-path-resolution.test.ts
  - test/unit/cost-attribution.test.ts
---

# M67 — CLI and attribution path correctness

## Purpose

A portability audit found three path-handling defects, all code-verified:

1. **Rooted globs never match anything.** `120fps "src/**/*.tsx"` matches zero
   files on every repo, silently.
2. **Case-insensitive filesystems drop a report.** Sweeping a directory with
   `Card.tsx` and `card.tsx` (different folders) writes one JSON file over the
   other on NTFS/APFS with no warning.
3. **pnpm cost attribution buckets under a package named `.pnpm`.** Every
   unbundled dependency measured under a pnpm install misattributes its
   scripting cost.

## Contract

### 1 — glob patterns match regardless of root shape

- `expandComponentPaths` MUST match a glob argument (`src/**/*.tsx`,
  `packages/ui/*.tsx`, `**/*.tsx`) against files returned by `PathReader.walk`
  whether `walk` returns paths relative to the working directory or absolute
  filesystem paths (`nodePathReader`'s production shape, via `path.resolve` at
  `src/cli.ts:1171` and `path.join` at `src/cli.ts:1162`).
- The compiled pattern (`globToRegExp`, `src/cli.ts:1075-1093`) stays anchored
  (`^...$`); the walked file's path is normalized against the pattern's frame of
  reference before the test, not the other way around.
- Windows-style backslash separators in both the pattern and the walked path
  MUST normalize to `/` before matching (existing `.replace(/\\/g, "/")`
  behavior, preserved).
- Leading-wildcard patterns (`**/*.tsx`) that matched before this fix MUST keep
  matching.

### 2 — report filenames dedupe case-insensitively

- `resolveReportPaths` (`src/cli.ts:793-807`) MUST treat two derived report
  basenames as colliding when they differ only in case, so
  `120fps-report.Card.json` and `120fps-report.card.json` never both get
  written when the filesystem cannot tell them apart.
- The collision suffix (`-2.json`, `-3.json`, ...) MUST apply on a case-folded
  key while the emitted filename keeps the component's own casing.

### 3 — pnpm store paths attribute to the real package

- `resolveSource` (`src/metrics.ts:84-142`) MUST extract the package name from
  the segment after the LAST `node_modules/` in the URL, not the first, so a
  pnpm store path (`node_modules/.pnpm/pkg@1.2.3/node_modules/pkg/index.js`)
  attributes to `pkg`.
- A scoped package under pnpm
  (`node_modules/.pnpm/@scope+pkg@1.2.3/node_modules/@scope/pkg/index.js`) MUST
  attribute to `@scope/pkg`.
- Flat `node_modules/pkg/...` and Vite's `node_modules/.vite/deps/pkg.js`
  attribution MUST stay unchanged (both contain exactly one `node_modules/`
  segment, so first-vs-last is a no-op for them).

## Design

**Glob matching moves to relative-path comparison.** `globRoot` already
computes the literal, non-wildcard prefix of a pattern (`src` for
`src/**/*.tsx`, `.` for `**/*.tsx`); `walk(globRoot(pattern))` is called with
that prefix. The regex, however, is anchored to match the pattern text
verbatim from position 0, which assumes the tested string starts the same way
the pattern does. `nodePathReader().walk` resolves its root with `path.resolve`
before recursing, so every returned path is absolute — it does not start with
`src/`, it starts with the OS drive/root. Making the walked path relative to
`process.cwd()` before testing restores the assumption the regex depends on,
for both the production reader (absolute paths in) and the test double already
in `test/unit/cli-path-resolution.test.ts` (relative paths in, where
`path.relative(cwd, relativePath)` is a no-op because Node resolves a relative
second argument against cwd first).

**Case-fold only the collision key.** `resolveReportPaths` already dedupes
identical basenames case-sensitively; folding the `Map` key to lowercase while
leaving the returned filename's casing untouched is the minimal change that
makes the second writer take the `-2.json` branch instead of overwriting the
first.

**Last `node_modules/`, not first.** pnpm's content-addressed store nests a
package's own `node_modules/<name>/...` symlink target inside
`node_modules/.pnpm/<name>@<version>/`. Every non-pnpm layout (flat installs,
Vite's `.vite/deps/`) has exactly one `node_modules/` segment, so switching
`indexOf` to `lastIndexOf` is a no-op for them and only changes behavior when a
second occurrence exists.

## Does NOT include

- `~/` expansion for CLI paths (deferred below).
- Any change to `src/harness.ts` or `specs/overview/*`.
- Any change to bucket naming, the react/package/user/browser taxonomy, or the
  nesting-stack dedupe in `src/metrics.ts`.

## Deferred

- `~/` expansion for CLI-supplied paths: PowerShell passes a literal `~` (no
  shell-side expansion), so this needs explicit handling in `expandComponentPaths`
  or `nodePathReader`. Out of scope for this milestone.
