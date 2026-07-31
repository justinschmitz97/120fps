---
kind: milestone
status: approved
tests: test/unit/m26-wrap.test.ts, test/unit/m26-wrap-harden.test.ts, test/e2e/wrap.test.ts, test/e2e/wrap-harden.test.ts
---

# M26 — provider wrapper

## Purpose

Components that read context (i18n, theme, motion features, router, query client) cannot be profiled bare: they throw at mount or render a degraded tree. `--wrap <module>` points 120fps at a user-authored module that supplies the environment, the same wiring every app already has as Storybook decorators.

## Non-goals

- Reading `.storybook/preview.tsx` directly, or any Storybook format. ADR 0002 keeps prop inference on the TS Compiler API; this milestone adds *environment* setup only and MUST NOT become a story loader.
- Deriving props/args from stories.
- Per-component or per-combo wrappers. One wrapper per run.
- Async setup that must complete before module evaluation (data seeding, MSW). See open question 2.
- Mocking modules (that is what M19 shims do).

## Contracts

### W1 — resolution

- CLI flag `--wrap <path>`; resolves against `process.cwd()`. A value is required: a missing value or a following `--flag` is a usage error (`--wrap requires a path argument`, exit 2). Missing file → `Wrapper module not found: <path>`, exit 2.
- CLI flag `--no-wrap` disables the wrapper, including auto-detection. It wins over `--wrap` (same precedence as `--no-isolate` over `--isolate`).
- `AnalyzeOptions.wrapPath?: string`, `AnalyzeOptions.noWrap?: boolean`. `resolveWrapPath(options, projectRoot)` resolves both against the project root and throws `Wrapper module not found: <path>` for a missing explicit path.
- Auto-detection when neither flag is given: probe `projectRoot` for `120fps.setup.tsx`, `120fps.setup.jsx`, `120fps.setup.ts`, `120fps.setup.js`, in that order; first hit wins. Directories matching a candidate name are skipped.
- Auto-detection is reported as `Report.wrapper.autoDetected`, never silent.
- The wrapper MUST live inside `projectRoot` — Vite serves the harness from there. Outside → `Wrapper module <path> must live inside the project root <root>`.
- Wrapper resolution and validation run before the harness directory is created, so a rejected wrapper leaves no `.120fps-harness-*` dir behind.

### W2 — module contract

- The module's **default export** MUST be a React component accepting `{ children }`. It is rendered once around the component under test.
- Module top-level side effects run at import time and are supported deliberately: stylesheet imports (`import "../app/globals.css"`), `document.documentElement.classList.add("dark")`, `document.documentElement.setAttribute("data-theme", "dark")`, locale registration. This is how theme selection is expressed.
- Optional named export `viewport?: { width: number; height: number }`. The entry re-exposes it as `window.__120fps.viewport`; every measurement session (`analyze`, `measureMount`, `measureRerender`, `explore`, `runReactAnalysis`) calls `applyWrapperViewport(page)` after the readiness gate and before throttle, warmup, and samples. Absent, non-numeric, or non-positive → Playwright default, silently. Read in the browser, not in Node: the wrapper module may import CSS and browser-only packages, so it cannot be evaluated in Node.
- No other named exports are read. Unknown exports are ignored, not an error.
- `buildAndServe` MUST reject a wrapper with no default export, or whose default export is provably not callable (object/array/string/number/boolean/null literal), with `Wrapper module <path> must default-export a React component taking { children }` — a clear error, not a page-error timeout. Function declarations, classes, arrow functions, identifiers, call expressions (`memo(...)`, `forwardRef(...)`) and `export { X as default }` / `export { default } from "./x"` are accepted; whether they are callable at runtime cannot be decided statically.

### W3 — injection

- `BuildHarnessOptions` gains `wrapPath?: string` (absolute).
- The import is emitted after the React imports and **before** the component import, as `import __120fpsWrap, * as __120fpsWrapModule from "/<posix(relative(projectRoot, wrapPath))>";`. ES module order means the wrapper's side effects (theme class, locale registration) run before the component module evaluates — the order an app provides. The namespace binding is what makes `viewport` optional: a bare named import of a missing export is a link-time `SyntaxError` in the browser.
- Both entry templates render through a single helper:
  ```
  const renderTree = (el: any) => root.render(__120fpsWrap ? createElement(__120fpsWrap, null, el) : el);
  ```
  Every render site routes through it, so each template contains exactly one `root.render(` call. Without a wrapper the emitted helper is `const renderTree = (el: any) => root.render(el);` — the template never references an undefined `__120fpsWrap`.
- With auto-scale (`__120fps_scaleN`), the wrapper wraps the **whole fan-out** — one wrapper, N component instances inside it.
- `HarnessResult` gains `wrapPath?: string` (absolute) and `wrapRelative?: string` (projectRoot-relative posix, reused by the React probe entry).
- Entry generation is exposed as `generateEntry(EntryOptions)` and `generateComposedEntry(componentRelative, tree, exports?, wrapRelative?)`.

### W4 — measurement semantics

- The wrapper is part of the rendered tree. Mount timing therefore includes provider mount. This is chosen over mounting providers once and swapping children, because it keeps `unmount()` semantics identical to the unwrapped path and avoids a second divergent lifecycle.
- The harness exposes `__120fps.mountWrapperOnly()`, which renders the wrapper with `null` children and marks the root mounted, so `unmount()` works unchanged.
- When a wrapper is active, `analyze()` runs a wrapper-overhead pass in its initial session (after calibration, before that browser closes — page ready, throttle set): `measureWrapperOverhead(page, cdp, samples)` does 2 warmup cycles (discarded), then `samples` cycles of GC → traced `mountWrapperOnly()` + double-rAF → untraced `unmount()`. Median → `Report.wrapper.overheadMs`. This is not `measureMount`'s job; it stays combo-only.
- `formatTable` prints the wrapper path and its overhead in the header block, so a reader can subtract it.
- Tier classification counts DOM nodes via `document.querySelectorAll("*").length`. A wrapper that renders DOM (a layout `div`) shifts the tier. `Report.wrapper.domNodes` records the wrapper-only delta — node count after `mountWrapperOnly()` minus node count of the empty harness page after `unmount()`, clamped to ≥ 0, captured once during the overhead pass — and `Report.warnings` gains a note when it is greater than 0.

### W5 — dependency scanning

- `scanExternalDeps` runs from the component and, when a wrapper is active, from the wrapper module; the union populates `optimizeDeps.include`. Otherwise the first mount pays Vite's on-demand optimize cost inside a measured sample.
- The alias list passed to both scans is `[...tsconfigAliases, ...shimAliases]` — a wrapper importing `next/navigation` resolves through a shim, and a wrapper importing `@ui/theme` resolves through tsconfig paths so the aliased file's own external imports are discovered.

### W6 — React analysis compatibility

- `runReactAnalysis` writes its own `probe-entry.tsx` and mounts the component inside `__120fpsContextProbe`. It applies the same wrapper **outside** the context probe, through the same `renderTree` helper, and re-exposes `viewport` the same way.
- `HarnessResult.component: { relative: string; name: string; isDefaultExport: boolean }` carries component identity; `runReactAnalysis` reads it instead of regex-scraping the generated entry. The old `/from\s+"\/([^"]+)"/` scrape is gone — with a wrapper import present it would have resolved the wrapper as the component.
- On the composed path, `component.name` is the composition root (`CompositionTree.root`) and `isDefaultExport` reflects whether that root is a default export.

### W7 — reporting

- `Report.wrapper?: { path: string; autoDetected: boolean; overheadMs: number; domNodes: number }` — `path` is `projectRoot`-relative posix. Set on the normal, curve, and matrix paths.
- `attachWrapperReport(report, wrapper)` sets the block and appends to `Report.warnings`:
  - `` `Wrapper <path> adds <n>ms to every mount measurement.` `` when `overheadMs >= 1`.
  - `` `Wrapper <path> renders <n> DOM node(s) counted in tier classification.` `` when `domNodes > 0`.
- `--no-wrap` reproduces pre-M26 behavior exactly.

## Design notes

- Rendering the wrapper inside the React root (rather than outside `#root`) is required for context to reach the component; a DOM-level wrapper would not work.
- The reference implementations in the dogfooding repos are `.storybook/preview.tsx` decorator chains: `LazyMotion → MotionConfig → ThemeProvider` in one, `NextIntlClientProvider` plus a surface `div` in the other. Both translate to a single default-exported component with no changes to their provider order.
- W6 fixed a latent bug: the deleted regex already broke if any earlier import in the entry contained `from "/…"`.
- A wrapper that imports stylesheets or fonts loads them asynchronously after module evaluation. M25's settle gate covers this: `needsStyleSettle` arms whenever a wrapper is active, not only when `--css` is (M25 C5).
- A wrapper that throws at import time never defines `__120fps`; the readiness gate times out and `page-errors.ts` enriches the timeout with the captured throw.

## Open questions

1. Should the wrapper also apply to the calibration trace? No — calibration stays a fixed, component-independent yardstick.
2. Async setup (`export async function setup()` awaited before the first mount) — needed for MSW-backed components. Deferred until a target component actually requires it; adding an await to the readiness gate is cheap but the failure modes (hanging setup) are not.
3. Should `viewport` live here or as a `--viewport` flag? Kept in the module because it travels with the same project convention.

## Verification

**Unit** (`test/unit/m26-wrap.test.ts`, `test/unit/m26-wrap-harden.test.ts`)
- Flag parsing: `--wrap` value required (missing, or followed by a flag), `--no-wrap`, both together, paths with spaces.
- `detectWrapper` probe order and extension precedence; directories skipped; unreadable root returns undefined.
- `resolveWrapPath`: explicit, auto-detected, `--no-wrap` precedence, missing-file throw.
- Entry generation: wrap import position, `renderTree` emitted once, exactly one `root.render(` per template, no-wrapper template free of `__120fpsWrap` and `viewport`, auto-scale fan-out wrapped once, scale-export branch routed, composed template wrapped, `mountWrapperOnly` present.
- `buildAndServe`: missing wrapper, non-callable default export, wrapper outside the project root, `.jsx` wrapper, class/arrow/re-exported defaults, `wrapPath`/`wrapRelative` recorded, posix normalization, spaces in the path, no `.120fps-harness-*` dir left behind when a wrapper is rejected.
- `HarnessResult.component` populated with the component (not the wrapper) even when the wrapper import comes first; composition root on the composed path; probe entry wraps outside the context probe.
- `scanExternalDeps` from the wrapper; the union reaching `optimizeDeps.include`; tsconfig aliases followed transitively through the wrapper.
- Report shape, warning texts and thresholds, `formatTable` header line.

**E2E** (`test/e2e/wrap.test.ts`, `test/e2e/wrap-harden.test.ts`)
- Context-dependent component: page error and empty root unwrapped; renders wrapped.
- Wrapper importing a stylesheet and setting `data-theme`: attribute present before the first mount, computed style reflects it.
- `viewport` export re-exposed and applied (`window.innerWidth` observed by the component); absent export → key absent; non-numeric values ignored.
- `measureWrapperOverhead`: expensive wrapper reports > 1ms and never exceeds the wrapped mount median by more than 50%; DOM-rendering wrapper reports `domNodes` 1, fragment wrapper 0; single-sample pass returns a finite median.
- Invalid and missing wrapper modules fail `analyze()` with the W2/W1 errors rather than a timeout.
- Full pipeline on `fixtures/wrap-project`: auto-detection reported, combos measured, interactions discovered, React analysis green.
- `--no-wrap` suppresses auto-detection and emits no wrapper warnings.
- `.jsx` arrow wrapper, class wrapper, re-exported default all render; wrapper throwing at import is captured as a page error; auto-scale fan-out yields 1 wrapper and N instances; `mountWrapperOnly` → `unmount` → `mount` cycles cleanly.
