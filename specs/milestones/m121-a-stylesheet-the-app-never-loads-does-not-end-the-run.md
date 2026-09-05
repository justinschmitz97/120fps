---
kind: milestone
status: approved
tests:
  - test/unit/stylesheet-contradicting-the-installed-tailwind-is-skipped.test.ts
  - test/unit/uncompilable-injected-stylesheet-degrades-to-unstyled.test.ts
---

# M121: A stylesheet the app never loads does not end the run

Lane A, run-6 remediation. Files: `src/harness/stylesheets.ts`, `src/harness/css.ts`,
`src/harness/style-tooling.ts`, `src/harness/stylesheet-probe.ts` (new), `src/harness/build.ts`,
`src/harness/index.ts`.

## Purpose

The stylesheet the harness injects is a guess whenever the project entry does not name one. A wrong
guess should cost styling, not the run. Three run-6 repositories lose the whole run to one: tooljet
picks a Tailwind 4 sheet in a Tailwind 3 project and the inliner parses `tailwindcss/lib/index.js`
as CSS; plane picks a fragment that only exists to be `@import`ed by the sheet the app really loads;
nuxt.com picks a sheet that never finishes compiling at all. After this milestone a candidate whose
Tailwind syntax contradicts the installed Tailwind is skipped before it is injected, and any injected
sheet that fails or hangs is dropped with the disclosure the harness already has for an unstyled
component.

Run-6 evidence: `C:\Projekte\120fps-fieldtest\smoke\run6-smoke1\FINDINGS.md` clusters 2, 4 and 7;
`logs/{tooljet,plane,nuxt.com}/real.log`.

## Root causes (verified)

1. **tooljet: the pick contradicts the toolchain.** `E:/repositories-run6/tooljet/frontend` has
   `tailwindcss` **3.4.17** installed (`node_modules/tailwindcss/package.json`, `main: lib/index.js`,
   no `style` field, no `exports`), while `src/styles/globals.css:1` is `@import "tailwindcss"`, the
   version-4 spelling. `src/harness/css.ts:321-332` picks it because the name matches
   `GLOBAL_CSS_CANDIDATES`; the app's own chain starts at `src/_styles/theme.scss` and the package
   has no `index.html`. Vite's css resolver finds no `style` field, falls back to `main`, and
   postcss-import parses the JavaScript file:
   `[postcss] postcss-import: E:\…\node_modules\tailwindcss\lib\index.js:1:1: Unknown word "use strict"`,
   `response 500: GET /src/styles/globals.css`, run over at the ready timeout.
2. **plane: the pick is a fragment.** `apps/web/styles/globals.css:2` is
   `@import "@plane/editor/styles"`, which resolves to `packages/editor/dist/styles/index.css`;
   `packages/editor/dist` does not exist, because the workspace package was never built. `injectable`
   (`src/harness/css.ts:280-292`) therefore rejects the entry sheet, correctly, and the size-ranked
   fallback (`:375-400`) injects `styles/emoji.css`, whose only importer is that same globals.css
   (`grep -rn emoji.css` over the repo: `styles/globals.css:5`). Standing alone it has no Tailwind
   context, so `@apply bg-surface-1!` is an unknown utility and the sheet 500s.
3. **nuxt.com: the pick never finishes.** Lane B's investigation: `app/assets/css/main.css` is a
   Tailwind 4 entry with `@source "../../../node_modules/.c12"` and `@import "@nuxt/ui"`, and its
   transform does not complete. The CSS import is the harness entry's first statement, so nothing
   after it evaluates and the run ends at the ready timeout with **no page error at all**. The same
   component reaches mount in about a second with `--no-css`.
4. **A stylesheet error is fatal because nothing looks at it before the browser does.** The entry
   imports the sheet, so a compile failure is a 500 on the entry's first import, and the only symptom
   is `component harness did not become ready within timeout`.

## MUST

- **A1** `stylesheetTailwindSyntax` reads a stylesheet's Tailwind dialect from its text: version 4
  for `@import "tailwindcss"`, `@theme`, `@utility`, `@custom-variant`, `@plugin`, `@source` or
  `@reference`; version 3 for `@tailwind base|components|utilities|screens|variants`; undefined when
  neither or both appear.
- **A2** A candidate chosen by conventional filename or by the size-ranked fallback whose dialect
  contradicts the installed Tailwind major is skipped, and the size-ranked walk moves on to the next
  candidate. The warning names the file, the dialect it uses and the installed version.
- **A3** A stylesheet the project entry imports, or one the package's own manifest declares, is never
  skipped for its dialect: the project itself is the evidence that it loads.
- **A4** After the dev server starts and before the page is opened, the harness compiles each
  injected stylesheet once, bounded at 20 s per sheet. A sheet that throws is dropped and reported
  with the compiler's first error line; a sheet that does not finish within the bound is dropped and
  reported as "did not compile within 20 s". Both warnings end in the harness's existing
  "the component may render unstyled" disclosure.
- **A5** A dropped sheet is removed from the harness entry, which is rewritten before the page is
  requested, and from the `cssFiles` the result reports, so the run's stylesheet disclosure names
  what was actually injected.
- **A6** nuxt.com's `app/assets/css/main.css` is the case the bound exists for: its transform never
  finishes, the CSS import is the entry's first statement, and the run must reach mount without it.

## MUST NOT

- The probe must not add wall time beyond the transform the page requests anyway: it compiles the
  same module the entry's first import would, and the page then reads it from Vite's module graph.
- A probe that times out must not block server shutdown or leave a `.120fps-harness-*` directory
  behind.
- A run whose stylesheets all compile must be unchanged: same entry, same `cssFiles`, no new warning.
- A dialect mismatch must not be reported when no Tailwind is installed, or when the file uses no
  Tailwind syntax at all.

## Verification

Tests first: both files import symbols that did not exist before this milestone
(`stylesheetTailwindSyntax`, `installedTailwindMajor`, `CSS_TAILWIND_SYNTAX_MISMATCH_WARNING`,
`probeInjectedStylesheets`, `CSS_COMPILE_FAILED_WARNING`, `CSS_COMPILE_TIMEOUT_WARNING`,
`CSS_COMPILE_TIMEOUT_MS`), so neither compiled until the implementation landed.

```
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
(no output)

node node_modules/vitest/vitest.mjs run \
  test/unit/stylesheet-contradicting-the-installed-tailwind-is-skipped.test.ts \
  test/unit/uncompilable-injected-stylesheet-degrades-to-unstyled.test.ts --maxWorkers=2
 Test Files  2 passed (2)
      Tests  16 passed (16)

node node_modules/vitest/vitest.mjs run <the 21 css, stylesheet, style-engine, runtime-engine and postcss unit files> --maxWorkers=2
 Test Files  21 passed (21)
      Tests  368 passed (368)

node node_modules/vitest/vitest.mjs run <the 10 unit files that call buildAndServe> --maxWorkers=2
 Test Files  10 passed (10)
      Tests  214 passed (214)
```

Corpus, through the scratch CLI built from this worktree, same wrapper invocation as M119:

| repo | before (0b3c496) | after |
|---|---|---|
| tooljet, `src/components/ui/Rocket/shadcn/separator.jsx` | `exit=2`, `[postcss] postcss-import: E:\…\node_modules\tailwindcss\lib\index.js:1:1: Unknown word "use strict"`, `response 500: GET /src/styles/globals.css`, `Stylesheets: src/styles/globals.css (matched a conventional filename)` | `exit=0 seconds=22`, `Result: PASS`, `Stylesheets: src/_styles/tabler.scss (largest-stylesheet fallback, low confidence — verify with --css)`, and `src/styles/globals.css was written for Tailwind 4, but this project has tailwindcss 3.4.17 installed, so it is not a stylesheet this project's own build compiles; it was not used as the stylesheet fallback. Pass --css to name the right one` |
| plane, `core/components/rich-filters/filter-item/loader.tsx` | `exit=2`, `Cannot apply unknown utility class 'bg-surface-1!'`, `response 500: GET /styles/emoji.css`, harness never ready | `exit=2 seconds=36` with the stylesheet no longer in the way: `styles/emoji.css did not compile ([postcss] tailwindcss: …/styles/emoji.css:1:1: Cannot apply unknown utility class 'bg-surface-1!' …); the stylesheet was not injected and the component may render unstyled`, and the run proceeds to a different, already-named layer: `../../packages/ui/src/avatar/avatar-group.tsx imports "@plane/propel/tooltip", which the dev server could not resolve to a loadable file` (an unbuilt workspace package, lane C's `deps-scan`/`workspace-entries` territory, out of scope here) |
| nuxt.com, `app/components/content/Carousel.vue` | `exit=2`, `component harness did not become ready within timeout. No page errors were captured.` | `exit=2 seconds=43`, `app/assets/css/main.css did not compile within 20 s; the stylesheet was not injected and the component may render unstyled. Pass --css to name a stylesheet that compiles, or --no-css to measure without one`; the run then reaches `calibration`, `mode: curve on items` and `mount: 6 scale points`, and stops on the component's own error, `mount phase failed on combo 0 of Carousel.vue: page.evaluate: TypeError: Cannot destructure property 'item' of 'undefined'` — the expected Nuxt auto-import consequence, not a stylesheet fault |

Shutdown after a probe timeout: `ls -d <repo>/.120fps-harness-*` over nuxt.com, plane, tooljet,
next-shadcn-dashboard and shadcn-admin returns 0 directories, and every run above exited on its own
(`killed=false`).

Probe cost, shadcn-admin `src/components/ui/label.tsx`, alternating in one window, two runs each
("before" = the shipped `0b3c496` tarball CLI, so the delta covers M120's plugin as well as M121's
probe):

| run | build phase | total |
|---|---|---|
| after 1 | 1 s | 1m 18s |
| before 1 | 5 s | 1m 23s |
| after 2 | 3 s | 1m 18s |
| before 2 | 4 s | 1m 42s |

Both "after" builds are inside the spread of the two "before" builds, so the probe adds nothing
measurable; all four runs are `exit=0`, `Result: PASS`.

Logs: `C:/Projekte/120fps-fieldtest/smoke/lane-a/{tooljet,plane,nuxt.com,shadcn-admin}/`.

## Deferred

- The 20 s bound is fixed rather than derived from the ready timeout or the measured noise level.
  Cluster 8 of the run-6 findings asks for a load-aware ready timeout; that is a separate decision
  and would set this bound with it.
- A stylesheet that hangs keeps its transform pending inside Vite until the server closes. The run
  proceeds without it, and `closeServerBounded` already bounds the shutdown.
