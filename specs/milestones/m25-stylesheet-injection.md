---
kind: milestone
status: approved
tests: test/unit/m25-css.test.ts, test/unit/m25-css-harden.test.ts, test/e2e/css.test.ts, test/e2e/css-harden.test.ts
---

# M25 — stylesheet injection

## Purpose

Without injection the harness page loads no CSS: no preflight, no utility classes, no custom properties, no fonts. Layout, style recalc, and paint — the things this tool measures — would be measured against the wrong stylesheet. M25 injects the project's global stylesheet(s) into the harness and makes every measurement session wait until styles and fonts have settled.

## Non-goals

- Theme selection (`.dark` class, `data-theme` attribute). A provider wrapper (M26) does this at import time.
- Per-component CSS module wiring beyond what the component's own module graph already imports (Vite handles that).
- Bundling or inlining CSS for a production build; the harness is dev-server only.
- Recreating the app's document chrome (body classes, layout wrappers, viewport meta).
- Adopting the project's full Vite config or plugin list.

## Contracts

### C1 — resolution

- CLI flag `--css <path[,path...]>`; comma-separated, each trimmed, empty segments dropped. A value that yields no paths (`--css ",,"`) is a usage error. A missing value, or a value starting with `--`, is a usage error.
- CLI flag `--no-css` disables injection entirely, including auto-detection. It wins over an explicit `--css` and skips its validation.
- `AnalyzeOptions.cssFiles?: string[]`, `AnalyzeOptions.noCss?: boolean`.
- `resolveCssFiles(options, projectRoot)` → `{ files: string[]; autoDetected: boolean }` with absolute paths. Explicit paths resolve against `process.cwd()`, are deduplicated by resolved path keeping first position, and suppress detection. A path that does not exist is a usage error `Stylesheet not found: <path>` (naming the path as typed); a path that exists but is not a file is `Stylesheet is not a file: <path>`. Both exit 2 through the CLI.
- An empty explicit list falls through to detection — only `--no-css` turns injection off.
- When no explicit paths are given, `detectGlobalCss(projectRoot)` probes in order and returns the first existing **file**:
  1. `app/globals.css`
  2. `app/global.css`
  3. `src/app/globals.css`
  4. `src/app/global.css`
  5. `src/styles/globals.css`
  6. `styles/globals.css`
  7. `src/index.css`
  8. `src/global.css`
- Auto-detection returns at most one file.
- `projectRoot` is `findProjectRoot(dirname(component)) ?? componentDir` — the same root `buildAndServe` computes.

### C2 — injection

- `BuildHarnessOptions.cssFiles?: string[]` (absolute paths, deduplicated by `buildAndServe`).
- Each file is emitted as a side-effect import at the **top** of the generated entry, before the React imports, the wrapper import, and the component import, in the given order:
  ```
  import "/<posix(relative(projectRoot, cssFile))>";
  ```
  Root-absolute, matching the existing component import, because Vite's `root` is `projectRoot`.
- A CSS file outside `projectRoot` is imported by absolute filesystem path (`/@fs/<posix abs>`, drive letter preserved). Detection never produces this; only explicit `--css` can.
- Injection applies to both entry paths — normal (`generateEntry`) and composed (`generateComposedEntry`). With no stylesheets the emitted entry is byte-identical to the uninjected one.
- `HarnessResult.cssFiles?: string[]` — the resolved absolute paths actually injected, omitted when empty.
- `index.html` is never touched. Vite injects dev-mode CSS as `<style>` during module evaluation, so `window.__120fps` cannot exist before the styles are in the document.

### C3 — dependency scanning

- `scanExternalDeps` starts from the component and the wrapper and is not extended to parse CSS. CSS-side dependencies (`@import "tailwindcss"`, `@plugin "..."`) are resolved by Vite/PostCSS at request time, not by `optimizeDeps`. `@import`/`@plugin` at-rules are not matched by the import regex.
- The `BLOCKED` set already strips `sass`/`less`/`stylus`/`lightningcss`/`sugarss` from `optimizeDeps.include`; unchanged.

### C4 — CSS toolchain

- **PostCSS (default path).** Vite resolves `postcss.config.*` from its `root`, which is already `projectRoot`. Tailwind 4 via `@tailwindcss/postcss` works with no config change. Verified by the `fixtures/css-tailwind` e2e project: preflight applies, `@theme` tokens resolve, and utility classes are generated — Tailwind's automatic source detection finds the component next to the stylesheet without an `@source` directive.
- 120fps never changes `process.cwd()`. Some project PostCSS configs resolve plugin paths against `process.cwd()`, so the process cwd stays whatever the user invoked from.
- **`@tailwindcss/vite` (plugin path).** When injection is active and the project's `package.json` lists `@tailwindcss/vite` in dependencies/devDependencies, `buildAndServe` loads that plugin from the **project's** `node_modules` (via `createRequire(projectRoot + "/")` + dynamic import) and appends it to `plugins`. Resolution or import failure → one stderr warning, run continues.
- No other project plugins are loaded. `resolve.alias`, `dedupe`, and `optimizeDeps` are unchanged.
- A CSS file that fails to compile makes Vite return 500 for that module, which stops `window.__120fps` from appearing. The harness runs with `server.hmr.overlay: false` so Vite's client logs the failure to the console instead of rendering it into a DOM overlay; the existing `page-errors` capture then carries the PostCSS message into the enriched readiness-timeout error, instead of a bare timeout.

### C5 — settle gate

- `needsStyleSettle(harness)` is true when stylesheets are injected **or a provider wrapper (M26) is active** — wrapper modules import stylesheets and fonts too.
- When armed, `settleStyles(page, harness)` runs after `window.__120fps` exists and before any calibration, warmup, or sample:
  1. `document.fonts.ready`, bounded by 5000 ms (`FONT_SETTLE_TIMEOUT_MS`); a browser without `document.fonts` skips straight through;
  2. one forced layout (`document.body.getBoundingClientRect()`), then two `requestAnimationFrame` ticks.
  It returns whether fonts settled. When not armed it is a no-op returning `true`.
- Timing out on fonts is non-fatal: `analyze()` appends `FONT_SETTLE_WARNING` (`"font loading did not settle within 5s"`) to `Report.warnings` for its own session and continues. The other sessions run the same gate but do not reach the report.
- The gate runs in every browser session that mounts the component — `analyze`, `measureMount`, `measureRerender`, `explore`, `runReactAnalysis` — placed after `applyWrapperViewport` and before `Emulation.setCPUThrottlingRate`, so it is not measured under throttle.
- One implementation (`measure.ts`), five call sites.
- Every harness navigation uses `waitUntil: HARNESS_NAV_WAIT` (`"domcontentloaded"`). A stylesheet whose webfont never answers keeps the `load` event pending forever, which would fail `page.goto` before the settle gate could bound it. Readiness is `window.__120fps`, not `load`.

### C6 — reporting

- `Report.css?: { files: string[]; autoDetected: boolean }` — `files` are `projectRoot`-relative posix paths in injection order. Absent when nothing was injected. Attached on the combo, curve, and matrix paths.
- The same list is passed to `buildEnvFingerprint` as `css` in `analyze()`, so `EnvFingerprint.css` (M29) carries it into every saved baseline. The key is omitted when nothing was injected, keeping pre-M25 baselines comparable. Baseline incomparability is reported per comparison, by name, through M29's `incompatible` classification.
- No blanket per-run "timings are not comparable" warning. A run with no baseline comparison emits no comparability warning at all.
- `formatTable` prints `Stylesheets: <files>` (plus ` (auto-detected)`) in the header block, after the wrapper line.
- Tier budgets (`TIER_BUDGETS`) are not retuned here. Absolute mount costs rise with a global stylesheet; M29's fingerprint is what keeps baselines honest about it.

### C7 — defaults and compatibility

- Auto-detection is **on** by default. Zero-config is the product goal, and an unstyled measurement is a wrong measurement.
- A baseline saved before injection was active carries no `css` in its fingerprint, so the first `--check` after upgrading classifies `incompatible` (M29), skips the comparison, and names the stylesheet in the mismatch text. It does not report false regressions and does not fail the run. Re-saving the baseline restores comparison.
- `--no-css` reproduces pre-M25 measurement behaviour.

## Design notes

- Both entry templates are string concatenation, so injection is a prepended `cssImportBlock`; no AST work.
- The harness dir lives inside `projectRoot`, so a relative import would also resolve — the root-absolute form is chosen for consistency with the existing component import.
- Wrapper-imported CSS lands *after* the injected block in the entry, so a wrapper stylesheet wins the cascade against `--css` for the same specificity. That matches the app, where the wrapper is the innermost layer.
- Vite's `publicDir` defaults to `<root>/public`; since `root` is `projectRoot`, `url(/fonts/x.woff2)` in a project stylesheet already resolves. The settle gate exists because those fonts load asynchronously.
- `--css` accepting multiple files covers projects that split reset/tokens/utilities; detection deliberately does not guess a multi-file order.
- The React probe entry (`generateProbeEntry`) does not inject `--css`. Its findings — render counts, memo bailouts, portal orphans, within-page callback deltas — do not depend on the stylesheet. Wrapper-imported CSS still reaches it through the wrapper import.

## Open questions

None. Resolved:

1. `--css` does not accept globs. Comma-separated explicit paths cover the observed cases; a glob would also have to define ordering, which the cascade makes load-bearing.
2. The settle gate does not await `document.readyState === "complete"`. It would be strictly harmful: `complete` implies the `load` event, which a stalled webfont blocks indefinitely — the exact case the 5 s bound exists to survive. The `__120fps` gate plus the forced layout and two rAF ticks are what the measurement needs.
3. With both `postcss.config.*` and `@tailwindcss/vite` present, PostCSS is what runs: Vite processes every CSS module through its PostCSS pipeline whenever a config resolves from `root`, and the plugin is only appended, never substituted. Nothing suppresses one in favour of the other, so a project with both pays for both.

## Verification

**Unit** (`test/unit/m25-css.test.ts`, `test/unit/m25-css-harden.test.ts`)
- `detectGlobalCss` probe order, per-candidate hit, first-hit-wins, directory candidates skipped, unreadable root.
- `resolveCssFiles`: detection flagging, explicit order, dedupe, `--no-css` precedence, both error messages, cwd-relative resolution.
- CLI parsing: comma split, trim, empty drop, only-commas error, missing value, flag-as-value, `--no-css`, help text.
- `cssImportSpecifier`: root-absolute posix form, `/@fs/` form, drive letters, spaces, sibling-prefix directories.
- Entry generation: byte-identical without css, block position ahead of react/wrapper/component imports, order preservation, both templates, one import line per file.
- `scanExternalDeps` ignores CSS at-rules and still collects JS packages.
- `detectTailwindVite` / `loadTailwindVitePlugin` including the not-installed warning.
- `needsStyleSettle` truth table; `settleStyles` no-op, settled, and timed-out paths against a stub page.
- Structural: the gate has one implementation and five call sites, each before CPU throttling; every `page.goto` uses `HARNESS_NAV_WAIT`.
- `EnvFingerprint.css` presence, omission, order sensitivity, and `incompatible` classification against a pre-injection baseline.
- `formatTable` stylesheet line, with and without the auto-detected marker.

**E2E** (`test/e2e/css.test.ts`, `test/e2e/css-harden.test.ts`)
- `fixtures/css-tailwind`: preflight applies, the `@theme` token resolves, and the `p-4` / `text-brand` utilities are generated (proves the project's PostCSS toolchain ran); with injection off the same elements show browser defaults.
- Compile failure surfaces the PostCSS message through the page-error capture — both an unresolvable `@import` and a syntax error inside a PostCSS-configured project.
- Cascade order across two stylesheets; `/@fs/` form for an out-of-root file; composed entry; `index.html` untouched; paths containing spaces; a file already in the component's own module graph.
- Settle gate: settles with a webfont present, returns false after the 5 s bound when the font request stalls (Playwright route), survives a browser without `document.fonts`, arms for a wrapper-only run, stays inactive for a bare component.
- A stalled font through the full pipeline: `Report.warnings` carries the settle warning and the run still produces timings.
- Full pipeline: auto-detection reported as `Report.css`, `--no-css` clears it, the saved baseline fingerprint carries `css` in order and omits it when nothing is injected, `Report.css` survives the JSON round trip, missing stylesheet errors with the spec message.
- `@tailwindcss/vite`: loaded from a project's own `node_modules` (fake plugin records that it ran), and one stderr warning with the run continuing when it is listed but absent.
