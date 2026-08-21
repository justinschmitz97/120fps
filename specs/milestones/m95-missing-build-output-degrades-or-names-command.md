---
kind: milestone
status: draft
tests:
  - test/unit/tsconfig-extends-broken.test.ts
  - test/unit/m95-m96-followup.test.ts
  - test/unit/bundler-error-presentation.test.ts
  - test/unit/stylesheet-selection-report.test.ts
---

# M95: missing build output degrades, or names its command

## Purpose

The decided policy: degrade and measure wherever possible; where a component genuinely cannot
resolve without the repository's own build, fail fast naming the exact command. Four shapes close
this milestone. **1.** nuxt-ui's `tsconfig.json:2` extends `./.nuxt/tsconfig.json`, which does not
exist, and `--explain-props` separately reports 0 props on all five candidates without ever
connecting the two. **2.** nuxt-ui's `src/runtime/components/*.vue` files import their theme from
`#build/ui/<name>`, a Nuxt build-time virtual module that cannot exist before `nuxi prepare`
generates `.nuxt/` — the same absent directory the broken `extends` chain names. **3.** ant-design's
`components/theme/useToken.ts` transitively imports `components/version/version.ts`, a file
`.gitignore` excludes and no plain `npm install` produces — every full run dies on a raw esbuild
`Could not resolve "./version"`. **4.** shadcn-ui's zero-config default run — `npx 120fps
./button.tsx`, the tool's headline case — discovers `app/globals.css`, which resolves and passes
every static check, but whose own internal reference to a Tailwind v4 generated `tailwind.css`
cannot be read at PostCSS-transform time; `--no-css` on the identical component passes cleanly,
proving the component itself was always measurable.

Closes: nuxt-ui-F1, nuxt-ui-F2, nuxt-ui-F3, ant-design-F7, shadcn-ui (stylesheet degrade).

## Contract

### MUST

- A broken tsconfig `extends` chain is reported with the missing path, and its downstream
  consequence is connected to it.
- A target pointing at absent build output is skipped with a warning naming it, and the run
  continues when the component can still render without it.
- When it cannot, the error names the exact command for that repository's toolchain (`nuxi prepare`,
  the package's own build/codegen script) rather than a generic instruction.
- A stylesheet that cannot be resolved or read — including one whose own internal reference is
  unreadable, discoverable only at real PostCSS-transform time, not at static discovery time — is
  dropped and the run measures unstyled instead of aborting, with a warning naming what was dropped,
  why, and how to fix it properly.

### MUST NOT

- Report an empty prop schema without naming the resolution failure that caused it.
- Require a build step silently.
- Degrade a stylesheet that resolves and then fails to *compile* (a real project error, e.g. a sass
  syntax error in a file that genuinely exists) — that keeps failing the run loudly, unchanged.

## Design

**1. Broken tsconfig `extends` chain, connected to its consequence.** `parseTsconfigPathsConfig`
(`src/harness.ts`) inspects the full `ts.ParsedCommandLine` result (not just its `.options`) for
`.errors`, scoped to diagnostic codes `5083` ("Cannot find a base configuration file") and `6053`
("File not found") — the two codes TypeScript actually uses for an unresolvable `extends` target.
Every other `parseJsonConfigFileContent` diagnostic is excluded by construction: code `18003` ("No
inputs were found") fires for the overwhelming majority of this project's own tmpdir test fixtures
(a config with no matching source files is a normal, working config) and would be a false positive
on nearly every existing test, not a real defect. `loadTsconfigAliases` pushes one
`TSCONFIG_EXTENDS_BROKEN_WARNING` per broken config file (member and, additively, workspace-root
layer) into the same `warningsOut` array `HarnessResult.warnings` already carries through every
failure path (M79) and M90 (Lane C) already renders alongside the report — nuxt-ui's `--explain-props`
run does not call `loadTsconfigAliases` (a separate, TypeScript-checker-only path in `prop-gen.ts`,
Lane B, out of this lane's files), but a full run's own crash (below) and its warnings block do, and
the two mechanisms below explicitly cross-reference this warning when it fired.

**2. Nuxt build-time virtual module (`#build/...`).** Node's own package-imports resolver — Vite
delegates to it for a `#`-prefixed bare specifier — throws `Missing "#build" specifier in "@nuxt/ui"
package` when `.nuxt/` (and the `imports` map entry it would populate) does not exist. This is a
distinct message shape from both of M94's `diagnoseBundlerFailure` patterns (Vite's own `Failed to
resolve import ... from ...` and PostCSS's `ENOENT`), so a new `diagnoseNuxtBuildModule` recognizes it
in `buildAndServe`'s `bootServer()` catch and replaces it with a 120fps error naming `nuxi prepare` as
the exact remedy. Not degradable: the failure means the whole dev server never started, so there is
nothing left running to continue measuring — this is the fail-fast half of the policy, not the
degrade half. When `buildWarnings` (already accumulated by the time this catch runs) contains a
`TSCONFIG_EXTENDS_BROKEN_WARNING` naming `.nuxt`, the message appends one sentence pointing back at
it — the join the first MUST requires, made concrete for the one repository where both facts are
reachable in the same run.

**3. Gitignored generated file (`ant-design`'s `./version`).** esbuild's own `Build failed with 1
error:\n<file>:<line>:<col>: ERROR: Could not resolve "<specifier>"` is caught by a new
`diagnoseGitignoredGeneratedFile`. For a relative specifier, it resolves the target against the
importer's directory (trying `SOURCE_EXTENSIONS` in turn, since esbuild reports the raw specifier,
not a resolved path), confirms no candidate exists on disk, then checks a git-root-relative form of
each candidate against the nearest ancestor `.gitignore` with a small, path-aware matcher
(`gitignoreCoversPath`) — exact match or a single `*` wildcard, the same rule `cli.ts`'s
`gitignoreCoversFile` already applies to a bare filename, extended here to a full relative path since
`.gitignore` entries are commonly path-scoped, not just bare names. When covered, the message names
the missing file and, best-effort, a command: `readProjectManifest`'s `scripts` field is checked in
priority order (`codegen`, `generate`, `prepare`, `postinstall`, `build`) for a script that plausibly
produces generated source; when none of those exist (ant-design's real toolchain is a custom `ut`/
`utoo` binary, not a standard npm script name — unguessable from `package.json` alone), the message
falls back to pointing at `package.json` scripts or the README rather than fabricating a command.
When the target is not gitignored (a genuine typo), this diagnosis returns nothing and the run falls
through to M94's existing `diagnoseBundlerFailure` / `stripBundlerStackFrames` chain unchanged.

**4. Unreadable stylesheet, degraded instead of aborted (`shadcn-ui`).** Static discovery
(`entryStylesheetImports`, `resolveCssFiles`) already drops a stylesheet specifier that never
resolves to a file on disk at all (`CSS_IMPORT_SKIPPED_WARNING`, `CSS_DROPPED_WARNING`) — unaffected
by this shape. What those checks cannot see is a stylesheet that *does* resolve, and only fails
later, at real PostCSS-transform time, because something it references internally (Tailwind v4's
generated `tailwind.css`) is not there; only Vite's real pipeline, on the first page request, ever
sees that nested reference. This surfaces on the same page-error channel M94's `diagnoseBundlerFailure`
already recognizes as a raw `[postcss] ENOENT: no such file or directory, open '<path>'`
(`POSTCSS_ENOENT_FAILURE`, `src/harness.ts`). `stylesheetReadFailureTarget` (`src/harness.ts`) is the
same pattern exposed as a detector, deliberately scoped to ENOENT alone so a stylesheet that resolves
and then fails to *compile* (a real error) never matches and keeps failing loudly — the MUST NOT.
`run()`'s first `enterHarnessPage()` call (`src/analyze.ts`) is wrapped in a try/catch: on a match,
with at least one discovered stylesheet in play, it discloses `CSS_UNREADABLE_DROPPED_WARNING`
(naming the dropped stylesheet(s), the unreadable target, that layout-dependent metrics may now
differ from a styled production render, and `--css` as the remedy once the generating build has run),
clears `resolvedCss.files`/`cssReport.files` (`cssReport.layer` becomes `"unreadable"`,
distinguishing this from `"disabled"`/`--no-css` in the disclosed report), rebuilds the harness with
no `cssFiles`, and retries `enterHarnessPage()` once, unguarded — a second failure is a different,
genuine problem and propagates normally, matching `--css`'s own explicit-file-missing check (a
synchronous, pre-boot `fs.statSync` failure in `resolveCssFiles`) which this shape does not touch.
`fingerprintValue` (the memoized `--save-baseline`/cache-reuse source fingerprint, computed lazily
from a thunk rather than a value frozen before this point specifically so it can) is reset on drop, so
a baseline saved from a degraded run is never indistinguishable from one saved from a styled run of
the same source.

## Open questions

None.

## Verification

- A fixture tsconfig whose `extends` target does not exist: `loadTsconfigAliases` pushes
  `TSCONFIG_EXTENDS_BROKEN_WARNING` naming the config file and the missing path, alongside its
  existing (unaffected) alias output for any `paths` it can still parse from the parts of the chain
  that do resolve. A workspace-root config with the same defect: the same warning, attributed to the
  root config file, independent of the member layer.
- A fixture where the member's own `extends` is broken but the workspace root has none: only the
  member's own warning fires.
- No regression: a tsconfig with a resolvable `extends` chain produces the identical alias output and
  zero new warnings.
- A synthetic `Missing "#build" specifier in "@nuxt/ui" package` error: re-presented naming `nuxi
  prepare`, with no raw package-resolution message. The same fixture with a
  `TSCONFIG_EXTENDS_BROKEN_WARNING` already collected for a `.nuxt` path: the message cross-references
  it.
- A synthetic esbuild `Could not resolve "./version"` error whose target is listed in `.gitignore`:
  re-presented naming the missing file and a discovered `scripts` command. The same shape with no
  matching `.gitignore` entry: falls through unchanged (a real typo keeps seeing the underlying
  esbuild message, stack-frame-stripped per M94).
- `stylesheetReadFailureTarget`: extracts the missing path from the exact live-proof page-error shape
  (a phase-prefixed "did not become ready" message wrapping a raw `[postcss] ENOENT` line); returns
  `undefined` for a stylesheet that resolved and then failed to *compile* (a sass "Undefined mixin"
  shape), for an unrelated failure, and for a Vite import-resolve failure on a non-stylesheet module
  — proving the negative case (a real compile error keeps failing the run) holds by construction, not
  by a second check.
- `CSS_UNREADABLE_DROPPED_WARNING`: names the dropped file(s) (both the single-file and
  every-discovered-file-dropped-together wordings), the unreadable target, the layout-dependent-metrics
  caveat, and `--css` as the remedy.
- `formatStylesheetsLine`/`formatTable` for `layer: "unreadable"`: distinct wording from `"disabled"`
  (never mentions `--no-css`, since the user did not ask for this), states the stylesheet was dropped
  and the run measured unstyled.
- No existing test in this codebase drives a real Vite dev server through a genuine PostCSS transform
  failure to unit-test `run()`'s retry-and-rebuild end to end (the same unit/e2e boundary M89's own
  spec draws, for the same reason: `enterHarnessPage`'s failure arrives on the real browser
  page-error channel, which nothing in this suite mocks). The wiring is instead verified by
  `tsc --noEmit` passing with the loop restructured around the try/catch; the full existing unit
  suite passing unchanged; and a source-level check (`test/unit/bundler-error-presentation.test.ts`)
  confirming the retry block actually calls `stylesheetReadFailureTarget`, rethrows unchanged when it
  returns `undefined`, discloses `CSS_UNREADABLE_DROPPED_WARNING`, sets `cssReport.layer` to
  `"unreadable"`, rebuilds with `cssFiles: undefined`, resets the memoized `fingerprintValue`, and
  retries `enterHarnessPage()` exactly once more.
