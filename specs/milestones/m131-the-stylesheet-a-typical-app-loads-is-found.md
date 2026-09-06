---
kind: milestone
status: draft
tests:
  - test/unit/entry-stylesheet-discovery.test.ts
  - test/unit/global-stylesheet-fallbacks.test.ts
  - test/unit/stylesheet-disclosure-completeness.test.ts
  - test/unit/the-entry-chain-finds-the-apps-global-sheet.test.ts
  - test/unit/an-exports-pattern-resolves-a-package-stylesheet.test.ts
  - test/unit/the-stylesheet-disclosure-says-which-pick-was-wrong.test.ts
---

# M131: the stylesheet a typical app loads is found where the app loads it

Lane C (`src/harness/css.ts`, `src/harness/stylesheets.ts`, `src/harness/stylesheet-probe.ts`,
`src/pipeline/resolve.ts`, `src/report/terminal.ts`, and the injected-stylesheet disclosure block in
`src/pipeline/phases.ts`).

## Purpose

The component under measurement is styled by the sheet its app loads. On the run-7 corpus the tool
found that sheet in a minority of cases and said so in a sentence that claims more than it checked:
`Stylesheets: none found (checked the project entry, conventional filenames, and the largest
stylesheet…)`. It is false for three of the four repositories that printed it, because the entry
walk knows only two shapes — an `index.html` module script and a Next.js entry stem — and gives up
one hop below the entry. Where the walk fails, a size-ranked fallback picks a sheet and discloses
that "no import chain corroborates the pick", after which 11 of 14 "0 rules matched" lines report
feature sheets that were never expected to match, drowning the 3 lines that are the real signal.
After this milestone the entry chain covers the shapes typical apps use, a package stylesheet
resolves through its `exports` patterns, and the disclosure separates a sheet that matched nothing
because it is a feature sheet from a pick that was simply wrong.

Evidence: `C:/Projekte/120fps-fieldtest/smoke/run7-FINDINGS.md` cluster 3 (F10-F13) and the logs of
logto, chatwoot, vue-vben-admin, nextjs-boilerplate, infisical, vue-pure-admin, documenso,
epic-stack, nuxt.com, posthog, excalidraw, soybean-admin and supabase in `smoke/run7-smoke1/`.

## Root causes (verified)

The verifier for every item below: run-7 investigation (2026-09-06), refuted by default; logs under
`C:/Projekte/120fps-fieldtest/smoke/run7-smoke1/logs/<repo>/`.

1. **The "none found" sentence claims a search that did not happen** — the text lives at
   `src/report/terminal.ts:109-112` and the decision it renders is
   `return { files: [], source: "none" }` at `src/harness/css.ts:448`. The ranked walk above it
   `break`s unconditionally at `src/harness/css.ts:419` as soon as `preprocessorFor`
   (`src/harness/stylesheets.ts:221`) has no preprocessor for a candidate, so the walk ends with no
   survivor and emits no warning about why. The verifier: it is false in 3 of the 4 repositories
   that printed it — logto (`packages/console/index.html:13` → `src/index.tsx:4` → `src/App.tsx:15-23`
   imports five global sheets one hop from the entry), chatwoot (`entrypoints/v3app.js:10` →
   `v3/App.vue` with `<style lang="scss">` plus `app.scss`), vue-vben-admin (`main.ts` → dynamic
   `import('./bootstrap')` → `import '@vben/styles'`, a workspace package). For nextjs-boilerplate it
   is true but uninformative: the only sheet is `@layer…; @import 'tailwindcss'` with zero bodied
   rules, rejected for a reason the message hides.
2. **A package stylesheet is looked up by exact `exports` key only** — `bareStylesheetTarget`
   (`src/harness/stylesheets.ts:306-331`) does an exact `exportsField["./" + subpath]` lookup at
   `:316`, never expands a `"./*"` or `"./*.css"` pattern, and never falls through to the on-disk
   probe at `:329-330`. The verifier: infisical's `@fontsource/jetbrains-mono/400.css` is reported
   "resolved to no file" although the file exists and the package's `exports` is `./*`; vue-pure-admin
   reports the same for `element-plus/dist/index.css`. novu's `@novu/maily-core/style.css` is truly
   absent and must stay reported.
3. **The entry walk knows two shapes and stops one hop short** — `findProjectEntry`
   (`src/harness/css.ts:60-84`) reads an `index.html` `<script type=module>` and `NEXT_ENTRY_STEMS`
   (`src/harness/css.ts:34` = `["app/layout", "src/app/layout", "pages/_app", "src/pages/_app"]`).
   `entryStylesheetImports` (`src/harness/stylesheets.ts:375`) rejects any import that has an import
   clause. The verifier, each a real corpus shape the walk misses: `app/root.tsx` for RR7/Remix
   (documenso `root.tsx:27` `import stylesheet from './app.css?url'`, epic-stack `root.tsx:30`);
   `nuxt.config` `css: ['~/assets/css/main.css']` (nuxt.com `nuxt.config.ts:89`); a bound import (the
   documenso line above); a side-effect import with no extension (posthog `import '~/styles'` →
   `src/styles/index.tsx`); one hop below the entry (excalidraw `index.tsx` → `App.tsx:147`
   `./index.scss`; soybean-admin `main.ts:2` → `plugins/assets.ts:4` → `styles/css/global.css`).
   Where the walk fails, `CSS_FALLBACK_WARNING` (`src/harness/stylesheets.ts:243-259`, decided at
   `src/harness/css.ts:424`, headed at `src/report/terminal.ts:65-69`) picks the largest sheet. Wrong
   picks with 0 matched rules: excalidraw, posthog, soybean-admin. Correct or unavoidable:
   hoppscotch, tooljet, mastodon (a Rails asset pipeline).
4. **The injected-sheet disclosure buries its own signal** — `src/pipeline/resolve.ts:35-41` builds
   `injected and none of its N rules matched`, emitted at `src/pipeline/phases.ts:535-555` behind the
   gate at `:551`. The verifier: 11 of 14 such lines in the corpus are entry-chain feature sheets
   (supabase's graphiql, monaco, reactflow and stripe sheets; vue-pure-admin's iconfont and tippy)
   while the app's own global sheet did match (supabase `globals.css`, 28 of 85 rules). The 3
   remaining lines are largest-fallback picks with 0 matched rules — exactly the case where the pick
   was wrong — and they carry the same wording and the same `--wrap` advice as the other 11. Pinned
   by `test/unit/stylesheet-disclosure-completeness.test.ts:35-46`.

## MUST

- **C1** The entry chain reaches a global stylesheet through each shape the corpus uses: an
  `index.html` module script (unchanged); a Next.js entry stem (unchanged); `app/root.tsx` for a
  React Router 7 / Remix app; the `css:` array of a `nuxt.config.*`; an import with a binding
  (`import x from './app.css?url'`); a side-effect import with no extension that resolves to a
  module (`import '~/styles'`); and at least one hop below the entry — the entry's own imports are
  followed one level, in source order, and any stylesheet reached that way is an entry stylesheet.
- **C2** The ranked walk does not stop at the first candidate it cannot preprocess. A candidate with
  no available preprocessor is skipped, the walk continues, and the reason that candidate was skipped
  is available to the disclosure.
- **C3** `Stylesheets:` states only what the run actually did. When no sheet is found, the line names
  the shapes that were searched and the reason each candidate was rejected — including "the only
  stylesheet declares no bodied rules" for a Tailwind-only entry sheet.
- **C4** A bare package stylesheet specifier resolves through the package's `exports` field including
  `"./*"` and `"./*.css"` patterns, and falls through to the on-disk probe when no pattern matches. A
  file that is genuinely absent is still reported as "resolved to no file", naming the specifier.
- **C5** The injected-sheet disclosure distinguishes two cases. Entry-chain sheets that matched no
  rules collapse into one line naming the count and up to three sheets, with no `--wrap` advice. A
  largest-fallback pick that matched no rules gets its own line stating that the pick is not
  corroborated by an import chain, that it matched nothing, and that `--css <file>` names the sheet
  directly.
- **C6** A sheet that did match rules produces no "none of its rules matched" line, and the
  disclosure is silent when every injected sheet matched.
- **C7** Dry/real parity (M100, M110): `--explain-props` reports the same stylesheet decision, the
  same source (`entry` / `fallback` / `none`) and the same warnings as the real run for the same
  component and flags.

## MUST NOT

- Execute the project's `vite.config`, its `nuxt.config` or any project code to find a stylesheet.
  Every shape in C1 is read statically from source. (The policy line: the harness never executes the
  project's Vite config; `src/harness/vite-config.ts:79-95`.)
- Drop an explicitly named `--css <file>` sheet, or override it with a discovered one.
- Change what the M121 compile probe drops. C1 and C2 change which candidates reach the probe; the
  probe's own verdict is M121's contract and stays as it is.
- Turn a false negative into a false positive: a repository with no global stylesheet (mastodon's
  Rails pipeline, tooljet, hoppscotch) still reports none found, with C3's reasons.
- Widen the walk without a bound. One hop below the entry is the contract; a full transitive walk of
  the app's module graph is not.
- Print the `--wrap` advice for a sheet that was never expected to match the component.

## Verification

- **C1, C2** — `test/unit/the-entry-chain-finds-the-apps-global-sheet.test.ts` and
  `test/unit/entry-stylesheet-discovery.test.ts`: one fixture per shape (index.html, Next stem,
  `app/root.tsx` with `?url`, `nuxt.config` `css:`, extensionless side-effect import, one hop below
  the entry through a plugin module) yields the expected sheet; a candidate whose preprocessor is
  unavailable is skipped and a later candidate still wins; a two-hop-deep sheet is *not* found (the
  bound holds).
- **C3** — `test/unit/global-stylesheet-fallbacks.test.ts`: a project whose only sheet is
  `@import 'tailwindcss'` with no bodied rules reports none found *and* names that reason; a project
  with no sheet at all reports none found with the list of shapes searched.
- **C4** — `test/unit/an-exports-pattern-resolves-a-package-stylesheet.test.ts`: a package with
  `exports: { "./*": "./*" }` resolves `pkg/400.css`; a package with `exports: { "./*.css":
  "./dist/*.css" }` resolves; a package with an exact key still resolves; a package with no matching
  pattern falls through to the on-disk probe and finds the file; a specifier whose file does not
  exist anywhere is reported as resolved to no file, naming the specifier.
- **C5, C6** — `test/unit/the-stylesheet-disclosure-says-which-pick-was-wrong.test.ts` and
  `test/unit/stylesheet-disclosure-completeness.test.ts` (rewrites `:35-46`): four entry-chain sheets
  with 0 matched rules produce one collapsed line with three names and no `--wrap`; a fallback pick
  with 0 matched rules produces its own line naming `--css`; a run whose sheets all matched produces
  no line; a mixed run produces exactly one collapsed line and one fallback line.
- **C7** — extend `test/unit/css-injection.test.ts`: the dry run and the real run agree on decision,
  source and warnings for each C1 fixture.
- Types: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` clean.
- Suite: the tests above plus `test/unit/css-injection-harden.test.ts`,
  `test/unit/uncompilable-injected-stylesheet-degrades-to-unstyled.test.ts`,
  `test/unit/stylesheet-candidate-validation.test.ts`, `test/unit/stylesheet-selection-report.test.ts`,
  `test/unit/package-declared-stylesheets.test.ts`,
  `test/unit/sass-import-compiles-with-a-disclosed-compiler.test.ts`, then the full unit suite once
  before the lane's final commit.

Recorded run of this milestone's verification:

```
<filled by lane C: tsc result, the vitest invocations and their verbatim totals>
```

Corpus repros, through a `dist` built in `C:/Projekte/120fps-run7-lane-c`:

```
node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run5/logto/packages/console \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-c/logto \
  --label m131-logto --cli C:/Projekte/120fps-run7-lane-c/dist/cli/main.js \
  -- src/ds-components/FormField/Skeleton.tsx --samples 3 --max-combos 2 \
     --explore-budget 30 --no-deltas
# expected: `Stylesheets:` names src/scss/normalized.scss (baseline "none found")

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run6/chatwoot \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-c/chatwoot \
  --label m131-chatwoot --cli C:/Projekte/120fps-run7-lane-c/dist/cli/main.js \
  -- app/javascript/v3/components/Form/CheckBox.vue --samples 3 --max-combos 2 \
     --explore-budget 30 --no-deltas
# expected: the entry chain reaches app.scss; the line names it

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run5/documenso/apps/remix \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-c/documenso \
  --label m131-documenso --cli C:/Projekte/120fps-run7-lane-c/dist/cli/main.js \
  -- app/components/general/portal.tsx --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# expected: app/root.tsx's ./app.css?url is the entry sheet; no CSS_FALLBACK_WARNING

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run5/supabase/apps/studio \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-c/supabase \
  --label m131-supabase --cli C:/Projekte/120fps-run7-lane-c/dist/cli/main.js \
  -- components/ui/DataTable/primitives/Kbd.tsx --samples 3 --max-combos 2 \
     --explore-budget 30 --no-deltas
# expected: one collapsed feature-sheet line, no --wrap advice, no line for globals.css

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run6/infisical/frontend \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-c/infisical \
  --label m131-infisical --cli C:/Projekte/120fps-run7-lane-c/dist/cli/main.js \
  -- src/components/v3/generic/DataGrid/ui/kbd.tsx --samples 3 --max-combos 2 \
     --explore-budget 30 --no-deltas
# expected: @fontsource/jetbrains-mono/400.css resolves through the ./* exports pattern

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run6/nextjs-boilerplate \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-c/nextjs-boilerplate \
  --label m131-nextjs-boilerplate --cli C:/Projekte/120fps-run7-lane-c/dist/cli/main.js \
  -- src/components/LocaleSwitcher.tsx --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# expected: the line states the only sheet is a Tailwind @import with no bodied rules
```

## Deferred

- **mastodon's Rails asset pipeline.** Its stylesheets are compiled by Sprockets from
  `app/javascript/styles`; no static import chain in the measured module graph reaches them. Out of
  scope; "none found" stays correct there.
- **hoppscotch and tooljet.** Their largest-stylesheet picks are recorded as correct or unavoidable;
  C5 changes only how a *wrong* pick is disclosed.
- **Executing `nuxt.config` or `vite.config` to read a computed `css` array.** C1 reads the literal
  array only. A computed one is a MUST NOT here and stays with M136's plugin work.
- **Ranking multiple discovered sheets by likely relevance.** C1 finds them; deciding which of five
  global sheets matters most to one component needs its own evidence.
