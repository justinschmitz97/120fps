# Changelog

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
