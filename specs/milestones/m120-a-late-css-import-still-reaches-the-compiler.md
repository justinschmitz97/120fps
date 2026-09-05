---
kind: milestone
status: draft
tests:
  - test/unit/late-css-import-still-reaches-the-compiler.test.ts
---

# M120: A late `@import` still reaches the compiler

Lane A, run-6 remediation. Files: `src/harness/css-import-hoist.ts` (new), `src/harness/build.ts`,
`src/harness/index.ts`.

## Purpose

`@import 'tailwindcss'` at the top, a few `@custom-variant` lines, then `@import './theme.css'` is
what a Tailwind 4 project writes when its theme lives in a second file. Under the app's own build
Tailwind resolves both imports and the theme is there. Under the harness the second import is
deleted before Tailwind ever sees the file, so every utility the theme defines becomes an unknown
class and the stylesheet 500s. After this milestone the harness moves such an import to the top of
the sheet, where the inliner accepts it, and the component is measured with the styles the app has.

Run-6 evidence: `C:\Projekte\120fps-fieldtest\smoke\run6-smoke1\FINDINGS.md` cluster 2;
`logs/next-shadcn-dashboard/real.log`.

## Root causes (verified)

1. **Vite inlines `@import` before every user plugin.** `node_modules/vite/dist/node/chunks/
   dep-Dq2t6Dq0.js:43740` computes `const needInlineImport = code.includes("@import")` and `:43751`
   does `postcssPlugins.unshift((await importPostcssImport()).default({...}))`. Next.js runs no such
   inliner: `@tailwindcss/postcss` resolves `@import` itself, at any position.
2. **The vendored postcss-import deletes an import that is not at the top.**
   `node_modules/vite/dist/node/chunks/dep-4-IQbZQm.js:292-310` walks backwards from the `@import`
   over comments, `@charset` and body-less `@layer` only, and otherwise returns
   `result.warn("@import must precede all other statements (besides @charset or empty @layer)")`
   without registering the import, so the statement never reaches the bundle.
3. **Observed on the real file.** `E:/repositories-run6/next-shadcn-dashboard/src/styles/globals.css`
   has `@import 'tailwindcss'` on line 1, `@custom-variant` on lines 5-11 and `@import './theme.css'`
   on line 12. A Vite 6.4 dev server with `css.postcss = { plugins: [dump, tailwind()] }` fails with
   `[postcss] tailwindcss: …/globals.css:1:1: Cannot apply unknown utility class 'border-border'`,
   and the CSS captured between the inliner and Tailwind contains `@import` 0 times, `data-theme`
   0 times and `--color-border` 0 times: the ten theme files are gone. The same plugin run alone over
   the same file (`postcss([tailwind()]).process(code, { from: file })`) succeeds with 63321 bytes,
   so the plugin is not the problem.

## MUST

- **A1** Before Vite's CSS plugin sees a `.css` module, the harness moves every top-level `@import`
  at-rule that follows a statement the inliner does not allow to the end of the sheet's leading
  import block, preserving the relative order of the moved imports.
- **A2** The statements the inliner does allow ahead of an import keep their place: `@charset`, a
  body-less `@layer` statement (which fixes layer order and must stay first), comments and the
  imports already in the leading block.
- **A3** Only `@import` at brace depth zero counts. The text `@import` inside a comment, inside a
  string, or inside a block is left where it is.

## MUST NOT

- A stylesheet whose imports already precede every other statement must come back unchanged, and the
  plugin must return `null` for it so no source map is invalidated.
- A request for the file's bytes rather than its stylesheet (`?raw`, `?url`, `?inline`) must not be
  rewritten.
- Nothing but `@import` statements moves; no rule, declaration or at-rule changes its position
  relative to another.

## Why hoisting matches the app's own build

A browser applies `@import` before every other rule in a stylesheet whatever line it sits on, so the
imported sheets are already first in cascade order; moving the statement up matches that, it does not
create it. Tailwind's own resolver accepts an `@import` at any position and inlines it in place, so
the set of `@theme`, `@utility` and `@custom-variant` declarations it collects is identical either
way. `@layer` order statements stay ahead of the moved imports, so cascade layer order is unchanged.
The only rules whose position changes are the imported ones, and they move from "deleted" to "in the
place the CSS specification already gave them".

## Verification

Tests first: `test/unit/late-css-import-still-reaches-the-compiler.test.ts` imports
`hoistStylesheetImports` and `cssImportHoistPlugin`, neither of which existed before this milestone,
so the file did not compile until the implementation landed.

```
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
(no output)

node node_modules/vitest/vitest.mjs run test/unit/late-css-import-still-reaches-the-compiler.test.ts --maxWorkers=2
 Test Files  1 passed (1)
      Tests  11 passed (11)

node node_modules/vitest/vitest.mjs run <the 16 css, stylesheet, style-engine and postcss unit files> --maxWorkers=2
 Test Files  16 passed (16)
      Tests  321 passed (321)
```

Mechanism, before the harness change, on a Vite 6.4 dev server with
`css.postcss = { plugins: [dumpInput, tailwind()] }`, root `E:/repositories-run6/next-shadcn-dashboard`:

```
transformRequest('/src/styles/globals.css')
  -> TRANSFORM FAIL: [postcss] tailwindcss: .../globals.css:1:1: Cannot apply unknown utility class `border-border`
dumped input: @import 0x, data-theme 0x, --color-border 0x
```

With a `enforce: "pre"` plugin that hoists the imports, same server, same file:

```
  -> TRANSFORM OK len=65934
dumped input: --color-border 9x
```

Corpus, through the scratch CLI built from this worktree (`032e0e2` plus this milestone's
uncommitted paths), same wrapper invocation as M119:

| repo | before (0b3c496) | after |
|---|---|---|
| next-shadcn-dashboard, `src/components/ui/separator.tsx` | `exit=2`, `Cannot apply unknown utility class 'border-border'`, `response 500: GET /src/styles/globals.css`, harness never ready | `exit=1 seconds=99`, report written, `Stylesheets: src/styles/globals.css (found in the project entry's own imports)`, no PostCSS, 500 or ready-timeout line in the log; exit 1 is the component's own budget verdict (`FAIL (T1)` on combo 0), not a setup error |
| shadcn-admin (unaffected), `src/components/ui/label.tsx` | reached a report | `exit=0 seconds=96`, `Result: PASS`, `Stylesheets: src/styles/index.css` |

Logs: `C:/Projekte/120fps-fieldtest/smoke/lane-a/{next-shadcn-dashboard,shadcn-admin}/m120-real.log`.

## Deferred

- The rewrite is silent. It restores the app's own behaviour rather than deviating from it, so there
  is nothing for a user to act on; a disclosure would read as a defect report about their CSS.
- A `.scss`/`.less` entry's `@import` is resolved by the preprocessor before postcss-import runs, so
  those files are out of scope.
