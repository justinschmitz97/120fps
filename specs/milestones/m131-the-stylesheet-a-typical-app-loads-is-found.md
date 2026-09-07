---
kind: milestone
status: draft
tests:
  - test/unit/entry-stylesheet-discovery.test.ts
  - test/unit/global-stylesheet-fallbacks.test.ts
  - test/unit/stylesheet-disclosure-completeness.test.ts
  - test/unit/stylesheet-selection-report.test.ts
  - test/unit/css-injection.test.ts
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
  stylesheet or to a module (`import '~/styles'`); and at least one hop below the entry — the
  entry's own imports are followed one level, in source order, and any stylesheet reached that way
  is an entry stylesheet. A `.vue` module reached that way contributes what its `<script>` block
  imports; its `<style>` block is compiled with the component and is no injectable file.
  The import's query decides whether it loads a sheet at all: `?raw`, `?inline`, `?worker` and
  `?sharedworker` hand over a string or a constructor and are never injected, and a binding is
  accepted only with no query or with `?url`.
- **C2** The ranked walk does not stop at the first candidate it cannot preprocess. A candidate with
  no available preprocessor is skipped, the walk continues, and the reason that candidate was skipped
  is available to the disclosure.
- **C3** `Stylesheets:` states only what the run actually did. When no sheet is found, the line names
  the shapes that were searched and the reason each candidate was rejected — including "declares no
  CSS rule with a body of its own -- it only pulls in Tailwind" for a Tailwind-only sheet, whichever
  layer rejected it. A sheet a conventional filename found and the ranked walk then skipped states
  its reason once, not once per layer.
- **C4** A bare package stylesheet specifier resolves through the package's `exports` field including
  `"./*"` and `"./*.css"` patterns, and falls through to the on-disk probe when no pattern matches. A
  file that is genuinely absent is still reported as "resolved to no file", naming the specifier.
  A `nuxt.config` `css:` entry naming a package (`element-plus/dist/index.css`, `vuetify/styles`)
  resolves the same way; one that resolves to nothing is named on the discovery line.
- **C5** The injected-sheet disclosure distinguishes three cases, and prints at most one line for
  the sheets that matched nothing. (a) Some injected sheet did match: the ones that did not collapse
  into a single line naming the count and up to three of them, with no `--wrap` advice, because a
  sheet this component never uses is not a finding. (b) No injected sheet matched anything: one line
  keeps the two readings M114 named -- an ancestor the harness does not render, fixable with
  `--wrap`, or `:root` custom properties that do cascade in. (c) A largest-fallback pick that
  matched no rules gets its own line stating that no import chain corroborates the pick, that it
  matched nothing, and that `--css <file>` names the sheet directly.
- **C6** A sheet that did match rules produces no "none of its rules matched" line, and the
  disclosure is silent when every injected sheet matched.
- **C7** Dry/real parity (M100, M110): `--explain-props` reports the same stylesheet decision, the
  same source (`entry` / `fallback` / `none`) and the same warnings as the real run for the same
  component and flags.
- **C8** A `.scss` or `.sass` stylesheet any layer reaches is injected when an implementation
  resolves for it, including the `sass` 120fps declares as its own dependency and Vite's fallback
  base resolves (M122). Only an extension with no implementation at all -- `.less`, `.styl` -- is
  refused, naming the package the project would have to install. When the injected sheet is the only
  edge that needed that fallback, the run prints M122's disclosure for it, in M122's own wording and
  from M122's own producer: after the project-transform classifier, only when that classifier
  disclosed none, and never under `--no-transforms`. A run carries one Sass disclosure or none.
- **C9** The size-ranked fallback never picks a Sass partial (`_name.scss`): Sass emits no stylesheet
  of its own for one, so no app loads it as its sheet. The reason is stated on the `Stylesheets:`
  line when the walk then finds nothing.

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

- **C1, C2, C8, C9** — `test/unit/the-entry-chain-finds-the-apps-global-sheet.test.ts` and
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
- **C5, C6** — `test/unit/the-stylesheet-disclosure-says-which-pick-was-wrong.test.ts`: four
  entry-chain sheets with 0 matched rules next to one that matched produce one collapsed line with
  three names and no `--wrap`; four with nothing matching anywhere produce one collapsed line that
  keeps the `--wrap` reading; a single sheet that matched nothing keeps M114's wording verbatim; a
  fallback pick with 0 matched rules produces its own line naming `--css`; a run whose sheets all
  matched, and a run the probe never reported on, produce no line at all.
- **C7** — extend `test/unit/css-injection.test.ts`: the dry run and the real run agree on decision,
  source and warnings for each C1 fixture.
- Types: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` clean.
- Suite: the tests above plus `test/unit/css-injection-harden.test.ts`,
  `test/unit/uncompilable-injected-stylesheet-degrades-to-unstyled.test.ts`,
  `test/unit/stylesheet-candidate-validation.test.ts`, `test/unit/stylesheet-selection-report.test.ts`,
  `test/unit/package-declared-stylesheets.test.ts`,
  `test/unit/sass-import-compiles-with-a-disclosed-compiler.test.ts`, then the full unit suite once
  before the lane's final commit.

Recorded run of this milestone's verification, 2026-09-07 in `C:/Projekte/120fps-run7-lane-c` at
`de41d6a` (the merged wave-1 tree), node 22.22.2, pnpm 9.7.0, other lanes sharing the CPU:

```
node node_modules/typescript/bin/tsc -p tsconfig.json      # exit 0

npx vitest run test/unit/the-entry-chain-finds-the-apps-global-sheet.test.ts   test/unit/an-exports-pattern-resolves-a-package-stylesheet.test.ts   test/unit/the-stylesheet-disclosure-says-which-pick-was-wrong.test.ts   test/unit/global-stylesheet-fallbacks.test.ts test/unit/css-injection.test.ts   test/unit/stylesheet-disclosure-completeness.test.ts   test/unit/stylesheet-selection-report.test.ts test/unit/entry-stylesheet-discovery.test.ts   test/unit/package-declared-stylesheets.test.ts   test/unit/stylesheet-candidate-validation.test.ts test/unit/css-injection-harden.test.ts   test/unit/sass-import-compiles-with-a-disclosed-compiler.test.ts   test/unit/dry-run-prints-project-transform-warnings.test.ts test/unit/module-ratchets.test.ts   --maxWorkers=2
# Test Files 14 passed (14); Tests 348 passed (348)

npx vitest run test/unit --maxWorkers=2
# Test Files 2 failed | 364 passed (366); Tests 2 failed | 5192 passed | 1 skipped (5195)
# The two failures are the recorded pre-existing ones: prop-cap-ranking.test.ts and
# vue-setup-inject-evidence.test.ts. Baseline at f54be55: 341 files, 4918 passed, 2 failed.
```

Corpus repros, dry runs through a `dist` built in `C:/Projekte/120fps-run7-lane-c`, logs under
`C:/Projekte/120fps-fieldtest/logs/run7-lane-c/<repo>/`:

```
node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd <appDir>   --out C:/Projekte/120fps-fieldtest/logs/run7-lane-c/<repo> --label dry --timeout 600   --cli C:/Projekte/120fps-run7-lane-c/dist/cli/main.js -- <component> --explain-props
```

| Repo | `Stylesheets:` before | `Stylesheets:` after |
|---|---|---|
| logto | `none found (checked the project entry, conventional filenames, and the largest stylesheet under the project)` | `node_modules/overlayscrollbars/styles/overlayscrollbars.css, src/scss/normalized.scss, src/scss/overlayscrollbars.scss, node_modules/react-color-palette/dist/css/rcp.css, node_modules/react-day-picker/dist/style.css (found in the project entry's own imports)` |
| chatwoot | `none found (checked the project entry, …)` | `none found (no project entry was found: …; app/javascript/dashboard/assets/scss/_next-colors.scss is a Sass partial, which no app loads on its own; …)` — see Deferred |
| documenso | `app/app.css (largest-stylesheet fallback, low confidence — verify with --css)` | `app/app.css (found in the project entry's own imports)`, no `CSS_FALLBACK_WARNING` |
| excalidraw | `share/ShareDialog.scss (largest-stylesheet fallback, …)` | `index.scss (found in the project entry's own imports)` |
| supabase | 13 sheets, entry-chain; 6 "none of its N rules matched" lines, each with `--wrap` | same 13 sheets; one line: `6 injected stylesheets (styles/graphiql-base.css, styles/monaco.css, styles/reactflow.css and 3 more) matched no element inside the component's own tree, while another injected stylesheet did match. …`; no `--wrap`; no line for `styles/globals.css` |
| nextjs-boilerplate | `none found (checked the project entry, …)` | `none found (no project entry was found: …; src/styles/global.css declares no CSS rule with a body of its own -- it only pulls in Tailwind)` |
| infisical | entry-chain without the jetbrains-mono sheets, plus `the project entry imports @fontsource/jetbrains-mono/400.css, @fontsource/jetbrains-mono/500.css, which resolved to no file…` | entry-chain including `node_modules/@fontsource/jetbrains-mono/400.css` and `/500.css`; no "resolved to no file" warning |
| epic-stack | `app/styles/tailwind.css (largest-stylesheet fallback, …)` | `app/styles/tailwind.css (found in the project entry's own imports)` |
| soybean-admin | `src/styles/css/nprogress.css (largest-stylesheet fallback, …)` | `src/styles/css/global.css (found in the project entry's own imports)` |
| vue-pure-admin | entry-chain without `element-plus/dist/index.css`, plus its "resolved to no file" warning | entry-chain including `node_modules/element-plus/dist/index.css` and `node_modules/vxe-table/lib/style.css`; no "resolved to no file" warning |
| nuxt.com | `app/assets/css/main.css (largest-stylesheet fallback, …)` | `app/assets/css/main.css (found in the project entry's own imports)`, read from `nuxt.config.ts`'s literal `css:` array |
| posthog | `src/lib/components/MarkdownNotebook/MarkdownNotebook.scss (largest-stylesheet fallback, …)` | unchanged — see Deferred |

Re-recorded at `de41d6a` after the review fixes, logs under
`C:/Projekte/120fps-fieldtest/logs/run7-lane-c-fix/<repo>/dry.log`: nextjs-boilerplate prints the
same `none found (…)` line naming `src/styles/global.css`; logto prints the same five entry-chain
sheets and exactly one Sass disclosure (`grep -c "falls through to the copy 120fps ships"` = 1);
documenso still reads `app/root.tsx`'s bound `./app.css?url`, and soybean-admin still reaches
`src/styles/css/global.css` one hop down. No corpus repository under `E:/repositories*` imports a
stylesheet with `?inline` or `?raw`, so that shape is covered by unit fixtures only.

The supabase disclosure was recorded on a real run, log
`C:/Projekte/120fps-fieldtest/logs/run7-lane-c/supabase/real.log:79`:

```
node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd E:/repositories-run5/supabase/apps/studio   --out C:/Projekte/120fps-fieldtest/logs/run7-lane-c/supabase --label real --timeout 600   --cli C:/Projekte/120fps-run7-lane-c/dist/cli/main.js --   components/ui/DataTable/primitives/Kbd.tsx --samples 3 --max-combos 2 --explore-budget 30   --no-deltas
# exit 0, 44.3 s, pass-warn, css layer=entry-chain files=13, 6 warnings
```

Scaffolds, the most typical entry shapes, all dry runs
(`logs/run7-lane-c/<scaffold>/dry.log`):

| Scaffold | Before | After |
|---|---|---|
| scaffold-rr7 | `app/app.css (largest-stylesheet fallback, …)` | `app/app.css (found in the project entry's own imports)` |
| scaffold-vite-react-ts | `src/index.css (entry)` | `src/index.css, src/App.css (entry)` — the one hop adds the sheet `App.tsx` imports |
| scaffold-vite-shadcn | `src/index.css (entry)` | `src/index.css, src/App.css (entry)` |
| scaffold-vite-vue-ts | `src/style.css (entry)` | unchanged |
| scaffold-create-vue | `src/assets/main.css (entry)` | unchanged |
| scaffold-next-app | (no candidate in run7-new1; measured `src/app/page.tsx`) | `src/app/globals.css (found in the project entry's own imports)` |
| scaffold-next-pages | `styles/globals.css (entry)` | unchanged |
| scaffold-t3 | `src/styles/globals.css (entry)` | unchanged |
| scaffold-nuxt | (no candidate in run7-new1; measured `app/components/Greeting.vue`) | `none found (…no stylesheet file exists under this project)` — the scaffold ships none |

A run's environment fingerprint includes the discovered stylesheet list, so a project whose
discovered sheets change here compares against a baseline recorded under the old list and re-records
rather than reporting a delta. That is the intended consequence of finding the right sheet: the
numbers are not comparable across a different injected stylesheet set.

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
- **chatwoot.** Its entry is a `vite-plugin-ruby` entrypoint directory, which only `config/vite.json`
  names, and its eight entrypoints have no single answer for one component. The reachable one,
  `app/javascript/entrypoints/v3app.js`, imports no stylesheet at all: the styling of `v3/App.vue`
  lives in that SFC's own `<style lang="scss">`, which the component compiles and no file can be
  injected for. The run now reports none found and names the two Sass partials it refused, which is
  true. Reaching it needs an entrypoint-directory shape and a rule for choosing among entrypoints.
- **vue-vben-admin.** Its entry reaches its styles through a dynamic `import('./bootstrap')` and a
  re-export chain, neither of which a static one-hop follow sees, and the measured package ships no
  stylesheet file of its own: `@vben/styles` is a workspace package the bootstrap module imports two
  hops down. Widening the walk to reach it is the transitive graph C1's bound excludes.
- **posthog.** It has no discoverable entry: `frontend/src/index.html` is a Django template with no
  module script, the build is esbuild (`build.mjs`), and `~` is a webpack alias no tsconfig declares,
  so `import '~/styles'` resolves to nothing. The largest-stylesheet fallback stands.
- **A second Sass disclosure.** C8's disclosure is emitted only where the project-transform
  classifier has already had its say, so a graph that names its own `.scss` edge keeps M122's
  message with its true import chain, and the injected sheet adds nothing.
