# Changelog

## Unreleased

Field-test run 7 remediation, in progress: fifty repositories measured against 0.7.0 (`f54be55`),
plus a further twenty-one new-repo diagnosis, closing eight clusters.
A fatal page error or a same-origin module server error that lands before readiness now ends the
run the moment it happens instead of waiting out the full bound, and the diagnosis that names the
cause is appended to the readiness report rather than replacing it: taxonomy's `env.mjs: Invalid
environment variables` throw ends the run in 4 s instead of 93, directus's `.yaml` module 500s end
it in 10 s instead of 94, twenty's unresolved `applyDiff.ts` import ends it in 25 s instead of 97,
and n8n's `~icons/` virtual-namespace 500 ends it in 25 s instead of 100. Every navigation now
carries the same bound the readiness wait advertises, instead of Playwright's own 30 s default.
uptime-kuma's sass 1.42.1 — installed, but too old for the `compileStringAsync` API Vite 7 calls —
is named instead of the run waiting out the bound with no diagnosis at all, and a `next/font/google`
import, a Next.js build-time module 120fps has decided never to shim, is now refused in the dry run
with the same words and exit code the real run already used (M129).
An unbuilt workspace sibling that a monorepo app imports by package name is now walked, typed and
aliased as its own package instead of stopping at the `node_modules` boundary three subsystems
disagreed about: directus's `.yaml` edge, previously invisible to the preflight walk, is a hard
refusal before the browser in the dry run and the real run identically; dub's `icon` prop, previously
invisible because the sibling's own types never resolved, is now extracted and required; twenty's
dry run drops from 149 false stale-alias lines to zero once an alias is judged against the tsconfig
that governs the file that wrote it rather than the measured package's own table; and a query-suffixed
alias import (`?url`, `?raw`, `?worker`) whose target exists is never wrongly flagged as broken, while
one whose target is genuinely missing inside the measured graph is now a hard preflight refusal
(M130). The dry run itself now resolves each module once per run instead of once per candidate, and
reads each tsconfig once per absolute path instead of re-parsing it every time, so posthog's
three-candidate `--explain-props` falls from 316 s to 116 s with byte-identical output (M135).
The entry chain that finds the stylesheet a typical app loads now follows the shapes the corpus
actually uses — React Router 7 and Remix's `app/root.tsx`, a `nuxt.config`'s literal `css:` array
including a package entry, a bound import carrying `?url`, and one hop below the entry in source
order — and a bare package stylesheet specifier resolves through a wildcard `exports` pattern as well
as an exact key; an import carrying `?inline` or `?raw` is never injected, because it hands the page
a string, not a sheet. The ranked walk no longer stops at the first candidate it cannot preprocess,
every sheet that matched nothing collapses into one disclosure line instead of drowning the few that
matter, and a `Stylesheets: none found` line now names the reason it found nothing instead of
asserting a search that never happened. M122's Sass disclosure now also covers a stylesheet reached
through this walk, not only one reached through the module graph (M131).
A passing run now pays for less of its own overhead and labels what it paid for truthfully: the
`calibration` phase holds only calibration, with the wrapper overhead, session close, schema
extraction and combination planning it used to absorb split into a new `setup` phase; the React
analysis pass measures each distinct prop set once instead of re-measuring the same auto-scale combo
up to four times; and the memo pass no longer mounts and rerenders a tree that carries no memo fiber.
`--explore-budget` now bounds the whole explore phase — the first combo, a single-combo run, and
every one of curve mode's scale points included — instead of a hardcoded per-combo default the flag
never reached: rallly's curve mode falls from 205 s to 47 s and novu's explore phase from 33 s to
18 s under the same `--explore-budget 30`. `observerTiming`, the cheaper sampling path the code
already named as the answer to explore's dominant cost, is now reachable by a caller as an opt-in;
it is not a new default (M134).
Explore no longer measures the browser's own attempt to leave the page: an anchor whose resolved
origin differs from the harness page, that carries `target="_blank"` or `rel="external"`, or whose
`href` is a `mailto:`/`tel:`/handler-less `javascript:` scheme is not exercised, and the discovery
line names how many targets were skipped and why. If a click nonetheless opens a popup or navigates
away, the run closes the popup, returns to the harness page, stops exercising that target, and
reports it as skipped rather than measuring the result. Withholding a FAIL on a noisy machine was
evaluated and not adopted: the signal was circular, the reconstruction was unsound, and it would have
contradicted the standing contract that budget verdicts are absolute, so a per-step breach still
fails however the noise sentinel classifies the machine (M137).
`--ci`, `--report-md` and `--report-junit` now carry the run's real verdicts instead of the empty
array nothing ever filled: every measured component's row matches the verdict the terminal printed,
and a sweep that exits 1 without any component reporting a failure gains one synthetic JUnit
testcase, named `120fps run`, whose failure says so. A `--check` run that reuses a stored verdict now
says exactly that and nothing else — no baseline-comparison line, no environment-match line, no mode
line, no measurement-basis line, and no interaction-count hint for a component it did not measure —
and it carries the reused entry's own warnings, replayed with control characters stripped and bounded
to ten entries of 300 characters each rather than lost to the cache; a stored entry recorded under a
different mode is named and re-measured rather than silently ignored. `--baseline-file <path>` names
where `--save-baseline` writes and `--check` reads, so a run need not dirty the measured repository;
it is refused before anything is measured when it names one file for a sweep spanning multiple
project roots, and a baseline that cannot be read names the path in its error (M138).

Every warning a passing run prints is now a statement the run can support, printed once, and names
what to change: a component that declares no props — soybean-admin's `soybean-avatar.vue`,
lobe-chat's `memo`-wrapped `Divider` — says so and states that extraction did not fail, and keeps the
old hedge only when the run has an actual reason to suspect a failed extraction, named in the same
line. A Vite config note names only the alias entries the run actually dropped, not `resolve.alias`
wholesale, and names a computed `plugins:` expression by its callee (`setupVitePlugins`,
`getPluginsList`) instead of calling it anonymous; the project-level note itself is now produced once
per measured component instead of once per candidate, so vue-pure-admin's three-candidate dry run
prints it once instead of three times, identically in the dry run and the real run. Node's own
`MODULE_TYPELESS_PACKAGE_JSON` warning about a project's own config file — midday's and plane's
`tailwind.config.ts` — no longer reaches the user's terminal, while 120fps's own warnings are
unaffected. Output a third party writes through `console.error` during a run — rallly's 7
`enhanced-resolve` stack lines from the Tailwind PostCSS plugin — is captured and printed, attributed
to the package that wrote it, only when no 120fps warning already reports the same fact; `DEBUG`
still shows everything. `--no-css` is honoured by the dry run exactly as it decides the real run, so
`--explain-props --no-css` reports no stylesheet instead of the file the real run was told to skip. A
provider hint names the hook the file actually imported — `react-router (useNavigate)` only when the
file imports `useNavigate`, otherwise "imports react-router" alone — instead of a hook the table
merely associates with the package. And anything-llm's warning now carries one `⚠ Warning:` prefix
instead of two (M132).

A render failure now names the provider it suspects and why: the scope table covers `@mantine/`,
`@chakra-ui/` and `@trpc/` beside `@radix-ui/`, and names the representative hook of `react-intl`,
`jotai`/`jotai-scope` and `@trpc/tanstack-react-query`/`@trpc/react-query`; when more than one
candidate exists they are ranked by whether the captured page error's own words name them, and the
remedy quotes that error — docmost's `@mantine/core` import now ranks first with `MantineProvider was
not found in component tree` as its evidence, and ai-chatbot's `@radix-ui/` import ranks the same way,
where the baseline found no suspect at all. A growth hint is never fitted over a tree that did not
render, in combo mode and curve mode alike, so trigger.dev's six non-rendering combos no longer
produce a `superlinearGrowth` hint over a curve that measured nothing. A prop named for a dimension —
`width`, `height`, `size`, `x`, `y`, `r`, `cx`, `cy`, `rx`, `ry`, `strokeWidth` — and typed `string`
synthesizes `"16"` instead of the placeholder `"test"` that rendered `<svg width="test">` on every one
of linkwarden's samples; a prop shaped `React.ElementType` synthesizes `"div"` instead of reaching
React as `undefined`, which is what threw on every scale row of dub's required `icon` prop. A
synthesized placeholder value that still reaches the DOM of a combo that rendered is disclosed as
`[harness fault]`, naming the prop, the value and the page error that names it, without changing the
combo's verdict. `--help` now describes exit 1 as the union of what it actually means — over budget, a
regression under `--check`/`--budget`, or a render error — and the README's render-error section gains
a worked example linking to the `120fps.setup.tsx` recipe (M133).

A Vue app's own generated auto-import maps — `components.d.ts`, `.nuxt/components.d.ts`,
`auto-imports.d.ts` — are now read and resolved in staged steps instead of leaving an auto-imported
identifier a free variable, without ever executing the project's Vite config: when a project does not
declare `@vitejs/plugin-vue` itself but a framework it does declare depends on it — Nuxt, then Vite —
the harness resolves the plugin through that framework's own dependency closure instead of only
through hoisting. A `components.d.ts` or `.nuxt/components.d.ts` map is parsed into a name-to-module
table and registered before mount for every entry whose module resolves inside the project's own
source tree; a dependency's own entry is named, not registered — the milestone's own stop condition
(C12) fired: registering `@nuxt/ui`'s `<UCarousel>` in full let it resolve and then fail to load with
a Nuxt-context error the browser reported as a 500, which `defineAsyncComponent` turned into a
silent, empty-tree pass, so only project-source entries are registered instead. An `auto-imports.d.ts`
map prepends an import for a free identifier the measured component's own module graph references,
scoped to that graph and never touching a module that already imports or declares the name. Every map
the run reads is named in its disclosures and joins the run's source fingerprint, and a registered
component the browser cannot fetch is named rather than silently rendering nothing. ADR
`0006-generated-declaration-files-are-a-resolution-input.md` records the decision. wg-easy, which
could not compile a single `.vue` file, drops from a 93 s setup-error to a 17 s pass; vitesse,
vue3-element-admin and it-tools move from a diagnosed `ReferenceError` to a pass; scaffold-nuxt's
"found via a hoisted transitive install" warning is gone; nuxt.com still aborts on the same
Nuxt-context error, but now names `UCarousel` and `ProseImg` and the map file that resolved them,
where the baseline's log never named the missing component at all (M136).

**Upgrading:** `phaseTimings` gains an eleventh key, `setup`, between `calibration` and `mount`; all
eleven keys still sum to `total`, and a baseline recorded before this key existed reads it as absent
without otherwise changing. A baseline recorded against a project whose discovered stylesheet list
has since changed re-records once, because the environment fingerprint's `css` list is now more often
accurate than before (M131); a baseline recorded against a project whose generated auto-import maps
have since regenerated re-records once for the same reason, because `generatedMaps` also joins the
fingerprint (M136). `--explore-budget` now bounds the whole explore phase rather than a hardcoded
per-combo default, so a slow machine explores fewer steps within the same bound instead of running
past it, and the run discloses when the budget stopped it, with one deliberate overrun: a combo that
starts with less than ten seconds of budget left is given ten seconds anyway rather than a walk too
short to reach a second state, so the phase can end up to ten seconds past the flag, disclosed on the
combo that carried it. `EXPLORE_BUDGET_WARNING` gained a third parameter (a unit name, `"prop combos"`
or `"scale points"`) and now names `--explore-budget <seconds>` as the way to raise it. A synthetic
curve's scale probes now carry the first measured combo's props beside `__120fps_scaleN`, so a
component with a required prop renders on its scale rows instead of throwing `Element type is invalid
... got: undefined` on every one of them. `--baseline-file <path>` is a new flag for `--save-baseline`
and `--check`; without it, the destination is unchanged. `--report-junit` may now contain a `120fps
run` testcase for a sweep that exits 1 without any component reporting the failure. `BaselineEntry`
gains an optional `warnings` field; a baseline file recorded before this release has none and loads
unchanged.

Known limits, by decision: a budget verdict is never downgraded for machine noise, even on a per-step
interaction breach — the evidence for a noise-based gate was circular, and the standing contract that
budget verdicts are absolute stands (M137); a framework-bound listener on a non-`http(s)` anchor —
Vue's `@click`, React's `onClick` — leaves no attribute for the discovery walk to read, so a
`javascript:` anchor bound only that way is still declined as a non-http link (M137). A Nuxt
composable or `#imports` binding, and a component a dependency provides through its own auto-import
map, are not supplied; the run names what it did not register rather than attempting a Nuxt
application context a bare `createApp` cannot provide, and a registered component the browser cannot
fetch is disclosed by name rather than failing the run — the milestone's own falsifier found that
requirement, and a future milestone owns it (M136). Two workspace siblings declaring the same alias
pattern to different targets cannot both be served by one Vite alias list; the conflict is disclosed
by name and the measured package's own target wins, per-importer resolution is disclosed, not served
(M130). Third-party output is captured only at `console.error`; a tool that writes straight to
`process.stdout`/`process.stderr` (linkwarden's daisyUI banner) still streams raw, because wrapping
the stream itself would buffer 120fps's own diagnostics (M132).

## 0.7.0

Field-test run 6 remediation: ten milestones closing run-6 smoke clusters 1 through 9 (cluster 9,
twenty's unbuilt-workspace-sibling subpath, by M126) plus the callback-identity performance finding,
closed.
The harness now loads a project's PostCSS config the way Next.js loads it: a string plugin name, a
`[name, options]` tuple, and a config re-exported from a shared tooling package all resolve, each
plugin resolved from the directory that actually declares it, so a shape `postcss-load-config`
rejects no longer ends the run as a harness-ready timeout (M119). A late `@import` — Tailwind 4's own
`@import 'tailwindcss'` followed later by a second import after some `@custom-variant` lines — is
hoisted ahead of the statements Vite's inliner already allows before an import, so the theme it
points at still reaches the compiler instead of being silently deleted (M120). A stylesheet candidate
whose Tailwind dialect contradicts the installed Tailwind major is skipped before it is ever injected,
and every injected stylesheet is compiled once, bounded at 20 s: one that throws is dropped and
reported with the compiler's error, one that "did not compile within 20 s" is dropped and reported as
such, both ending in the harness's existing "the component may render unstyled" disclosure instead of
an unexplained ready timeout (M121). A readiness timeout now names the global it waited for
(`window.__120fps`), the seconds it waited, the two usual causes, and `FPS120_READY_TIMEOUT_MS` as the
way to raise the bound, instead of the bare sentence "did not become ready within timeout." on its own
(M125). A workspace sibling's `exports` subpath that builds flat into a nested output layout (twenty:
15 of its 20 export keys) resolves to its own source the same way the sibling's root entry already
does, instead of stopping the run on an unaliased subpath (M126). A component whose import graph
reaches `react-native` is measured through `react-native-web` when it is installed, and the run stops
naming React Native and the importing file instead of ending in a wall of raw esbuild errors when it
is not; a `.d.ts` entry a tsconfig's `customConditions` selects is never handed to the dependency
pre-bundle either way (M127). The callback-identity pass, previously 97% of the React analysis phase,
now measures each distinct prop set once instead of up to four times and skips a `*Capture` prop whose
bubble twin it already probes, so the analysis phase runs roughly 4x faster on both profiled repos;
`renderAttribution` is measured in its own reset-mount-rerender window instead of accumulating across
every callback arm (M128).

**Upgrading:** `FPS120_READY_TIMEOUT_MS` is a new environment variable, read as a positive whole
number of milliseconds; an unset, non-positive or unparseable value keeps the default of 90000 and is
disclosed once per process. `renderAttribution`'s `renderCount` and durations are redefined as a
single reset-mount-rerender window (M128) rather than an accumulation across every callback-identity
arm: values are smaller by design and not comparable against a 0.6.0 baseline for that field alone;
every other reported field is unaffected. `sass` is now a dependency of 120fps itself (install size
grows; a project's own sass still wins whenever it resolves from the measured package or its
workspace root). A `babel-macro` import that used to print as a warning and let the run continue is
now a hard preflight refusal before the browser; `--no-preflight` bypasses it the same way it bypasses
every other preflight hit.

A `.scss`/`.sass` import in a project that declares no Sass implementation now compiles with the Sass
120fps ships instead of dying 30 s later on Vite's raw install hint, and the run says so once, in the
dry run and the real run with the same words, naming the version; a `.less` or `.styl`/`.stylus`
import whose implementation resolves from neither the project nor 120fps is a named refusal before the
browser, carrying the install command for this repository's own package manager (M122). A Nuxt project
whose generated `.nuxt/` directory is missing a file its own tsconfig names is refused before the
browser, identical in the dry run, naming the `nuxi prepare` remedy; a readiness timeout that captured
no page error at all now names the stylesheet the run injected as the first suspect, with `--no-css`
and `--css <file>` as the two commands that decide whether it is the cause — a ranked suspect, never a
verdict (M123). A component whose import graph reaches a Babel macro import 120fps cannot compile
(`*/macro`, `*.macro`, `babel-plugin-macros`) is refused before the browser, with the same message in
the dry run and the real run, naming the importer, the macro and the compiler the project declares for
it; `--no-preflight` bypasses the refusal and runs the rest of the pipeline unchanged (M124).

Module layout (M118, ADR 0005): `src/` is nine stage directories (`cli`, `pipeline`, `analysis`,
`report`, `browser`, `harness`, `props`, `project`, `shared`) with one-responsibility files of at
most 800 lines, value imports pointing one way through stage `index.ts` files, one helper per fact
in `src/shared/`, and comments that state the invariant instead of the milestone. Two unit tests
enforce the layout. No measured behaviour changes: the unit suite reports the same passing set before
and after, and `--explain-props` output is byte-identical.

**Upgrading:** the CLI binary is `dist/cli/main.js` (the `120fps` bin entry follows; `npx 120fps`
is unchanged). The package's programmatic surface is now the curated set in `src/index.ts`
(`analyze`, `buildReport`, the Report types, `formatMarkdown`, `formatJUnit`, `loadBudgetConfig`,
`validateBudgetConfig`, `hintsForReport`, `formatHints`, `HINTS`, `parseArgs`, `PropSchema`,
`PropCombination`). This is breaking for anyone who imported 120fps programmatically beyond that
set: 325 runtime values and 106 types the 0.6.0 barrel re-exported (`measureMount`, `explore`,
`extractProps`, `buildAndServe`, `runPreflight` and the rest) are no longer reachable from the
package root. The capability was real but never documented.

Field-test run 5 remediation: the thirty confirmed findings against 0.6.0, closed.

**Upgrading:** preset lookup now checks `<stem>.120fps.props.tsx` and `<stem>.120fps.props.ts` before the
existing `<stem>.props.tsx`/`.props.ts` names; both old names keep working. `phaseTimings` is a new field on
the report and on `--save-baseline` entries; a baseline recorded before this release just reads as "no phase
timings recorded". Nothing forces a re-record, and `METRICS_REVISION` (`src/report/budget.ts`) is unchanged, so
no baseline invalidates.

Resolution:

- An unbuilt workspace sibling with no `<pkg>/src` (`@directus/utils`, its source at `shared/index.ts`) or with
  no runtime entry at all (`@react-types/shared`, `types` only) is aliased to the source its own `package.json`
  points at, tried in order (`source`, `exports` conditions, `module`/`main`, `types`, `<pkg>/src`), and the
  printed warning names the field it followed instead of asserting a `dist/` that was never declared; a sibling
  reached only through another sibling's alias is rescued in the same pass (directus, gutenberg: exit 2 -> a
  verdict; react-spectrum: no more false "unbuilt dist/" claim) (M107).
- A `#`-prefixed specifier resolves through the importer's own `package.json` `imports` field before any
  bundler-failure message is chosen, so a Node subpath-imports convention is measured as a local import instead
  of collapsed to a bare package name and matched against the Nuxt `#build` diagnosis (epic-stack's `#app/*`)
  (M108).
- The tsconfig reader follows a references-only root (create-vite's own template) to the referenced config that
  covers the file, compiles `.ts`/`.tsx`/`.js`/`.jsx` with the automatic JSX runtime whatever the config's `jsx`
  value is, skips a `paths` key whose non-wildcard prefix is empty (`"/*"`) instead of building an alias that
  captures `/@vite/client`, and forwards `customConditions` to the dev server: ark's accordion no longer throws
  `React is not defined`, coordinator's references-only root resolves its aliases, react-spectrum's `/*` entry
  no longer 404s the harness's own client and its `source`-conditioned subpaths resolve (M109).
- Two runs of one component that differ only in the shell directory produce the same stylesheet decision, the
  same warnings and the same verdict: a member's Tailwind 3 config resolves nearest-member-first instead of from
  `process.cwd()` (midday: exit 2 from the repository root -> a report), and every run names the member root and
  workspace root it resolved (M111).

Diagnoses and remedies:

- A diagnosis names the layer that actually failed instead of a generic Nuxt remedy: the `#build`/`#imports`/`#app`
  diagnosis fires only when the specifier starts with one of those and `nuxt` is declared in the measured
  package or at the workspace root, so a missing Node
  subpath (epic-stack) or a React 18 project's React Compiler mismatch (primer-react, now targeting the
  installed React major instead of defaulting to 19) get their own message; a Babel-macro import is a preflight
  hit instead of surfacing as "Unable to determine current node version" (documenso), and a virtual-namespace
  import (`~icons/`, `virtual:`) names the plugin package that declares it (hoppscotch) (M108).
- A remedy never names a file that already exists as real source: radix-themes' own `button.props.tsx` is
  disclosed by path ("exists, not a preset: no default-exported object literal") and every remedy points at
  `button.120fps.props.tsx` instead of asking for a file that is already there; a preset candidate
  with the wrong shape is disclosed by path ("exists, not a preset") instead of silently ignored (epic-stack); a
  preset already applied stops repeating the "add a preset" clause in the same run's output (logto); and
  `--init-fixture` on the path whose own warning recommends it now writes the fixture instead of doing nothing
  (radix-themes) (M112).
- An explicit `--matrix` the dispatcher overrides in favor of an auto-composed scene now prints one warning
  naming what took precedence, in both the dry run and the real run, instead of silently measuring one combo
  (cal.com) (M110).

Dry run parity:

- `--explain-props` decides auto-composition from the same filesystem inputs the real run's dispatcher uses, so
  it no longer predicts matrix mode for a component the real run auto-composes (supabase, cal.com); it prints
  the same project-transform warnings, the same unresolved `optimizeDeps.include` entries and the same
  multi-line `import { ... } from` specifiers the real run reads from disk, so logto's ConfirmModal and
  supabase's Popover no longer look clean and then fail a minute later, and epic-stack's `#app` import no
  longer produces a dep-optimization failure in the real run that the dry run said nothing about: it resolves
  through the project's own `imports` map, so neither mode reports it; a `.yaml`/`.yml`/`.toml`/`.md` import is a preflight hit naming its loader plugin
  when the project declares one (directus) (M110).

Disclosures:

- A Griffel-styled component reports `styling is generated at runtime by @griffel/react` instead of "no
  stylesheet found" (fluentui), and an unrecognized `makeStyles`/`styled` import gets its own "unrecognised
  engine" line instead of reading like a plain miss; a package stylesheet declared in `package.json` whose
  target does not exist is reported as declared-but-unbuilt, naming the field, the missing path and the
  package's own build command, instead of falling through to "none found" and a size-ranked fallback file
  (radix-themes) (M112, M114).
- A matrix never crosses a controlled prop with its `default`-prefixed twin (fluentui's Dialog `open` and
  `defaultOpen` no longer set together), a barrel re-export reports the declaring module's props instead of
  zero (gutenberg), a call-wrapped default export (`forwardRef(Button)`) reports the wrapped name instead of a
  sibling export (logto), the Vue plugin hint fires only for a `$`-prefixed proxy frame, and a read of undefined
  in an ordinary SFC render frame gets the provide/inject hint only when the same run recorded an `inject(`
  call in the measured component (ark, which recorded none, now prints no hint at all), and a captured console message
  substitutes `%s`/`%d`/`%o` from its arguments before it is recorded, so React's dev warnings read as text
  instead of a raw template (supabase) (M114).

Runs terminate and clean up:

- `SIGINT`/`SIGTERM`/`SIGHUP` leave no `.120fps-harness-*` directory behind on Windows, even with Chromium and
  the dev server still holding handles at the moment of the signal: the pre-close removal retries a busy handle
  for up to 1 s instead of failing once and swallowing the error (base-ui, intermittent on 1 of 2 attempts
  before this milestone); a directory that survives every retry is named on stderr instead of disappearing
  silently, and the next run's stale-directory sweep reports what it removed instead of nothing (M113).

Where the minutes go:

- A run reported one number, its own wall clock. Every completed run's report now carries `phaseTimings` (`preflight`, `build`, `calibration`, `mount`, `rerender`,
  `explore`, `scale`, `deltas`, `attribution`, `analysis`, `total`, summing exactly to `total`) in the terminal
  `Total:` breakdown, the JSON report and `--report-md`; `--explain-props` prints an estimated real-run
  duration built from the last `--save-baseline` entry's phase timings for that component when its environment
  fingerprint still matches, or says it is using documented defaults when none does (M115).

Faster:

- Explore replays a state-invariant stress pattern's path from the root once per edge instead of once per
  sample (today only `scroll-sweep`); `runPreflight`'s import-graph parse and `scanExternalDeps`'s walk are
  cached per (absolute path, mtime, size) within one process instead of re-run up to four times per component
  across a directory sweep. What changed is what is paid for once: the paired A/B runs that gated this change
  showed identical verdicts, warnings, interaction rows and preflight hits on both arms, and only the measured
  `phaseTimings.explore`/`.preflight` numbers moved. No other reported number changed.

Output:

- A static-prebuild warning a harness rebuild re-emits (a dropped stylesheet, a rolled-back composition) prints
  once with a `(×N)` suffix instead of appearing twice in the same run's warning list; the vite-config note
  names the plugins the harness actually dropped (`tanstackRouter, react, tailwindcss`) instead of the bare key
  `plugins`, and omits a plugin whose transform the run already applied; the noise line names only the signals
  that crossed their threshold and the one flag that helps, instead of four sentences naming no flag; the
  `.gitignore` tip fires only for a path actually inside the repository the run started from (was: any report
  path, by basename alone); `--report-md` now carries each component's deduped warnings in a fold, as the
  README already promised (M117).

Known limits, by decision: the harness never runs a workspace sibling's own build, or any project Vite plugin
(M107, M108); solution-style tsconfig `references` with build-output redirection are not followed (M109); a
package's own CSS is discovered only through its entry's side-effect imports; a stylesheet reached transitively
through the modules that entry imports is still unfound (vuetify's `main.sass`, three hops away) (M114); the harness
directory still lives inside the project root, and two concurrent runs still share no removal lock (M113);
levers B/C's win is paid once per process; a cross-process cache stays deferred, and Lever D (one driven session shared across
delta and scale-curve passes) stays deferred pending a separate cold-context risk decision (M116); noise-tagged
FAILs are not downgraded to WARN before a verdict prints, and there is no per-invocation flag to suppress the
vite-config plugin note (M117).

## 0.6.0

Field-test release: 0.5.0 was run, unmodified and zero-config, against twenty real repositories chosen to stress it.

- A crash caused by a value 120fps synthesized is not your component's FAIL: the combo is marked `[harness fault: <prop>]`, excluded from `Result`, and hinted toward a `<stem>.props.tsx` preset. The rule needs error text naming the mechanism (`asChild`, `Slot`, `Slottable`, …), so a missing-provider crash is still yours.
- A page error raised while transitioning to the next combo's props is disclosed on the row that triggered it as `[→ #N: k page errors]` (`transitionPageErrors`) and no longer counts against a combo that did not throw it.
- A compound component measured by its bare `Root` while its declared siblings never mount is `WARN [uncomposed]`, not a silent PASS; Vue props declared Options-API style (`props:`, `extends`, `mixins`) are `WARN [props excluded]` instead of looking propless. `disclosureReason` in JSON, in matrix cells too.
- Curve points that render nothing are tagged `[renders nothing at N=…]` and excluded from the fit; a curve that is empty at every point FAILs with the render hint instead of passing as a flat line. A curve that crashes on every scale point gets `[render error]` and the `--wrap` hint like combo mode does.
- A memory-isolation run on a `hostile` machine no longer force-fails on `leakSuspected` alone (the signal stays in JSON, with a warning). Scale probes are no longer counted in "N of M combos".
- Bound-like numeric props (`min`, `max`, `step`, `tabIndex`, `zIndex`, …) never auto-activate curve mode; `*Provider` exports are never the default pick.

Props:

- JavaScript components: `.js` and `.ts` files are accepted (was: `.tsx`/`.jsx`/`.vue`), JSX in `.js` compiles with the automatic runtime, and a sibling `.d.ts` supplies the props (ADR 0004). MUI `Badge.js`: 2 → 16 props; `Chip`, `Tabs`, `Autocomplete` reach a report instead of `React is not defined`.
- The 32-prop cap keeps what matters: required props, props the component's own source references, named variant axes (`variant`, `size`, `colorPalette`, …) and the component's own declarations rank ahead of inherited DOM attributes (Chakra `badge.tsx` listed 32 inherited `<span>` props and none of its own). Extraction binds to the export actually measured. A preset can restore a prop the cap dropped.
- Vue: dual-block SFCs (`<script lang="ts">` + `<script setup>`) extract (Nuxt UI `Badge.vue`: 0 → 14 props); a preset can add props to a component whose own declarations are out of reach (PrimeVue Options-API components); `this.$slots.default()` no longer crashes on mount; `string | number` is a union; unresolved types are named.
- Synthesized values are valid where they are used: `src`/`srcSet`/`poster` get a `data:` URI instead of a 404ing `"test"`, `currencyCode`/`locale` get real ISO/BCP 47 values at any nesting depth, `Iterable<T>` gets an array, mixed unions (`boolean | 'trap-focus'`) get a real member with the collapsed branches disclosed, and an unsynthesizable object/render prop is omitted rather than passed a fabricated `{}`. Every value carries `provenance`. A self-referential generic degrades to a warning instead of a stack overflow.
- `--explain-props` gains a `default` column and prints every warning the real run decides from disk (`Stylesheets:` line, alias/preflight/shim notes, mode prediction with the real dispatcher's precedence); runtime-only refusals are listed in its footer. It rejects Solid and Yarn PnP the way the real run does.

Stylesheets:

- Discovery reads the measured package's own `package.json` (`style`, `exports["./styles"]`) before falling back to the largest file (HeroUI: "none found" → its declared stylesheet). Placeholder sheets that only `@import`, opt-in `reset.css`/normalize files, and sheets unreadable at transform time are skipped with a warning instead of chosen or fatal; 0-rule passthroughs expand one `@import` hop; Sass/Less partials resolve; bare specifiers resolve through `exports`.
- `Stylesheets:` and `report.css` are always present, with `layer` (`explicit`, `entry-chain`, `known-name`, `package-declared`, `largest-fallback`, `runtime`, `unreadable`, `disabled`, `none`), per-file rule and byte counts, and `matchedRules` from a CSSOM probe: a sheet whose rules match nothing in the rendered tree warns "measured as if unstyled". Runtime-styled projects (Emotion, styled-components, `@ant-design/cssinjs`, PrimeVue) read `none — styling is generated at runtime`. The decision is emitted as soon as it is made, so it survives a later crash.
- `css.preprocessorOptions.<lang>.additionalData` from `vite.config` is folded and replayed (was: `Undefined mixin`).

Resolution:

- Workspace members inherit tsconfig `paths`, `vite.config` `resolve.alias`/`resolve.conditions` (string literals and `resolve()`/`join()` calls) and `120fps.setup.*` from the workspace root, each use disclosed. `paths` with a mid-path wildcard (`"@mantine/*": ["./packages/@mantine/*/src"]`) build a working alias. A workspace sibling with an unbuilt `dist/` is aliased to its `src/`. A sibling imported only by subpath no longer manufactures an unresolvable root entry.
- Type-space is not runtime-space: a `paths` alias pointing at `@types/*` and type-only packages (`csstype`) are skipped with a warning instead of crashing esbuild. A Vite/PostCSS/esbuild failure is re-presented as a 120fps error naming target, importer and remedy, never a raw stack through 120fps's own `node_modules`.
- Next shims: `next/navigation` adds `ReadonlyURLSearchParams`, `permanentRedirect`, `RedirectType`, `useSelectedLayoutSegment(s)`, `unstable_rethrow`; `next/headers` adds `draftMode`; `next/image` adds `getImageProps`. Importing an export a shim lacks names the shim, the export and `--no-shims`.
- Missing build output names its command: a gitignored generated file names the `package.json` script that produces it, through the detected package manager (`pnpm run version`); Nuxt `#build/*` before `.nuxt/` exists names `nuxi prepare`; a broken tsconfig `extends` chain names the missing path next to the empty prop count. An import cycle back to the measured module is a preflight hit with the hop chain.

Runs terminate and clean up:

- `SIGINT`/`SIGTERM`/`SIGHUP` sweep the harness directory, close Chromium and the dev server, and exit `128+signo`. Every `.120fps-harness-*` directory carries a `.pid` marker: dead-owner directories are swept on the next run at any age, live ones after 10 minutes without a heartbeat, at workspace-member roots too. Harness directories are removed on exit 0 as well.
- A fatal error exits within 10 s even when server teardown hangs (was: ~20 min); a run-wide watchdog bounds the whole run at `max(--explore-budget + 10 min, 20 min)`.
- Transient frame starvation, `Tracing.tracingComplete` timeouts and closed targets in the delta, rerender and explore phases retry per combo and degrade to a disclosed omission instead of ending the run (cal.com `DatePicker`: exit 2 after 124 s → report in 59 s). Stress patterns are bounded by the remaining budget.
- Exit codes: an uncaught harness failure exits 2 (setup error), not Node's default 1 (verdict failed); a watchdog abort exits 2.

Messages are true of the run:

- A project with no `node_modules` is told so instead of "React 18+ required"; `react-dom` failures are diagnosed by cause (not installed, not declared, not linked, outdated, Yarn PnP, Preact alias). `--no-preflight` is never re-advised once passed; bypassed findings are labelled by kind (`yarn-pnp`, `solid`). Stall hints name the flag for the phase that stalled (`--no-deltas`, `--samples`/`--max-combos`) instead of `--no-attribution`. Provider hints say "import graph reaches X" for transitive hits and ignore wrapper-only hits. Mount-phase aborts naming Vue plugin globals or slot access get a remedy instead of a bare stack.
- Warnings recorded before a failure are printed with it, at every throw site. Matrix headers state which axes were crossed and which props were held at their default or absent (`Held absent (…)`, `variant: 2 of 12 values crossed`); non-axis cells never receive a synthesized truthy value. Render attribution prints in curve and matrix modes. Unresolved `<use href="#id">` sprite references are disclosed. A placeholder value that 404s against the harness origin is not attributed to your component. `2m 60s` → `3m 0s`; `--help` states both scale defaults.

Known limits, by decision: a `120fps.setup.tsx` wrapper's own CSS imports are discovered, but CSS imported by the modules it imports is not; a type-only re-export still breaks auto-composition (`--no-auto-compose` measures); Solid, Yarn PnP and `preact/compat` are refused, not supported.

## 0.5.0

Portability release: 120fps now works on repos that don't look like the ones it was built against.

**Upgrading:** in workspace repos, baselines re-record once (the workspace lockfile now participates in the source fingerprint). Single-package repos are unaffected.

- Workspace-aware project model: monorepos (pnpm/yarn/npm workspaces, Turborepo) get correct tooling detection — root-declared Tailwind, Next, React Compiler, and `@vitejs/plugin-vue` are found (previously `.vue` files in a monorepo didn't mount at all). `--compare` links `node_modules` at every workspace level.
- Config resolution: tsconfig found by upward search (`extends` chains resolve), `jsconfig.json` and `baseUrl`-only projects get aliases, JS components extract props. Broken or shape-mismatched `paths` aliases warn instead of silently dying.
- Import scanning: dynamic `import()` / `require`, `?url`/`?raw` suffixes, `.json`/`.cjs`, and directory `exports`/`main` all resolve; a missing alias target warns instead of polluting the dep optimizer.
- CSS discovery reads your entry's real imports (index.html chain, Next `layout`/`_app`) before falling back to known names, then the largest stylesheet — each layer validated and disclosed. Tailwind loads independently of CSS discovery. Literal `resolve.alias` / `publicDir` are recovered from `vite.config` without executing it; `process.env.NEXT_PUBLIC_*` / `VITE_*` come from your `.env` (secrets excluded). UnoCSS/Linaria/Panda setups warn instead of measuring unstyled.
- Failures name their cause: CSS and font 404s are captured (was: a bare 30s timeout), failed font loads warn, read-only project roots and React <18 get purpose-built errors, Solid and Yarn PnP are rejected upfront with remedies, Preact behind a `react` alias skips the fiber profiler with a warning, Node <22 exits cleanly, provider hints cover react-router/Remix/Gatsby/TanStack, `.wasm`/shader imports get "needs plugin X" preflight notes, and a hint suggests `.gitignore` patterns for report artifacts.
- Next shims: `next/script`, `next/head`, `next/router`, `next/font/local` added (10 total); any other `next/*` import warns as unsupported.
- Fixed: `--compare` on Windows deleted files from your real `node_modules` during worktree cleanup (`git worktree remove --force` recurses through junctions; present since `--compare` shipped in 0.3.0).
- Fixed: rooted and absolute glob patterns match again; case-colliding report filenames no longer overwrite each other on NTFS/APFS; pnpm cost attribution names the real package instead of `.pnpm`.

## 0.4.0

- Prop extraction binds to the exported/target component: internal helpers can no longer hijack the schema. `#ExportName` targets a specific export.
- Render crashes surface: page errors attach per combo, zero DOM + a throw = `FAIL [render error]` instead of a silent pass. Crash messages name phase, combo, and a fix hint.
- Prop synthesis: cva `VariantProps` unions enumerate, tuples and domain objects get real values, Maps/Sets degrade loudly, duplicate combos de-duped.
- Scale-probe combos labeled `×N copies` (`scaleProbe` in JSON); `--max-combos` bounds matrix mode; combo counts reconcile; expensive probes capped with a notice.
- Curve classification is stable (significance gates, no more linear↔quadratic flips); curve FAILs name the budget and crossing point; explicit `--curve` warns when nothing is curveable.
- Animation detection uses running animations, not declared CSS; animation/portal is a tier floor, not an override.
- Cost attribution reports mean scripting per mount (was: sum over all samples); `useReducer` dispatch / `useState` setters no longer flag as callback-identity problems.
- Next.js shim usage reported again (`nextJsShims`).
- `--explain-props` dry run; phase progress lines + `Total:`; provider-hook hints on render failures; `report.mode`; `--json` split notice on multi-component runs; memo/forwardRef names resolve in attribution.

## 0.3.0

**Upgrading:** metrics revisions bumped: every 0.2.x baseline classifies `incompatible`. Nothing fails; re-record with `--save-baseline`.

New modes:

- `--compare <gitref>`: interleaved A/B against a git ref, informational
- `--report-md` / `--report-junit`: PR-comment markdown and JUnit XML

New inputs:

- directories and globs (`npx 120fps "src/components/**/*.tsx"`)
- `<stem>.props.tsx` prop presets
- wrapper `setup()` / `teardown()` (async, awaited before first render)
- project transforms (svgr, vanilla-extract) loaded from your `node_modules`

Measurement honesty:

- measured-state disclosure (`pending-network`, `late-mutation`)
- noise sentinel: `quiet` / `noisy` / `hostile` machine classification
- server-only preflight fails in seconds naming the import chain
- volatile DOM (timestamps, random ids) no longer mints phantom states
- remediation hints with README anchors

Statistics: type-7 P95, sample-variance CV, per-combo warmups, churn parity, per-event interaction budgets.

Baselines: per-environment slots (laptop and CI don't collide), 90-day pruning, verdict reuse for unchanged components (`cached: true`, `--no-cache` to force).

Performance: shared Chromium pool + one Vite server per project, begin-frame pacing (~2 ms vs ~33 ms per fence), shared prop-extraction program cache. 385s → 300s matrix, 97s → 81s composed, before pooling.

Also: `--max-combos` / `--explore-budget` disclose caps, `--init-fixture`, `--no-cache` / `--no-preflight` / `--no-transforms`, matrix-baseline warning, scroll/wheel stress, `npm test` = unit only.

## 0.2.1

- Fixed interaction attribution and reporting in matrix mode.

## 0.2.0

- Global stylesheet injection with a font/style settle gate.
- Provider wrapper (`--wrap`, auto-detected `120fps.setup.tsx`).
- React Compiler awareness: compiled projects are measured compiled.
- Baseline environment fingerprints, `--baseline-env strict|normalize|ignore`.
- `--isolate` pipeline (mount, rerender, unmount, memory, strictmode).
