---
kind: milestone
status: approved
tests: test/unit/m27-compiler.test.ts, test/unit/m27-compiler-harden.test.ts, test/e2e/compiler.test.ts
---

# M27 — React Compiler awareness

## Purpose

Without this milestone, JSX and TS go through Vite's built-in esbuild transform and nothing else. A project that ships with React Compiler enabled is then profiled **untransformed**: none of the automatic memoization that runs in production is present in the measurement.

Two consequences, both wrong in the same direction:

1. Rerender and interaction costs are measured against hand-written code that the compiler would have memoized. Numbers are pessimistic by an unknown factor.
2. `detectMemoBailouts` flags every component whose `renderCount` increased across a same-props rerender. Code that relies on the compiler for memoization re-renders in the harness, gets reported as a memo bailout, and `hasReactWarning` downgrades the combo verdict from `pass` to `warn`. The tool reports a problem that does not exist in the shipped app.

Both dogfooding targets run `reactCompiler: true` with `babel-plugin-react-compiler@1`.

## Non-goals

- Shipping or vendoring the compiler. It is resolved from the project, never bundled.
- Enabling the compiler by default for projects that do not declare it. `--react-compiler` is an explicit opt-in, not a default.
- Reporting compiler diagnostics ("this component bailed out of compilation"). Read-only awareness only.
- Comparing compiled vs. uncompiled cost as a product feature.
- Babel for anything else. No decorators, no styled-components transform, no custom babel config discovery.

## Contracts

### K1 — detection

- `detectReactCompiler(projectRoot): boolean` — true iff `babel-plugin-react-compiler` appears in `dependencies`, `devDependencies`, or `peerDependencies` of `<projectRoot>/package.json`. Missing or unparseable package.json → `false`; a dependency section that is not a plain object is skipped, not trusted.
- Package presence is the only signal. `next.config.*` is not parsed — it can be TS, can compute its config, and adds a whole evaluation surface for one boolean.
- Consequence (accepted and documented): a project that has the plugin installed but disabled will be profiled *with* the compiler. This errs toward matching production for the common case; `--no-react-compiler` is the escape hatch.

### K2 — transform

- When the compiler is active, `buildAndServe` MUST append `@vitejs/plugin-react` to the Vite config's `plugins` array, configured as:
  ```
  react({ babel: { plugins: [[reactCompilerPath, compilerOptions]] } })
  ```
- `@vitejs/plugin-react` is a **dependency of 120fps**. `babel-plugin-react-compiler` MUST be resolved from the *project's* `node_modules` via `createRequire(projectRoot + "/")`, so the compiler version matches what the project ships.
- `compilerOptions` defaults to `{}`. No target/`sources` configuration in this milestone.
- When active, `react/compiler-runtime` MUST be added to `optimizeDeps.include` if the project can resolve it. Compiled output imports that module, and `@vitejs/plugin-react` only pre-bundles it when it recognises the babel plugin by its bare name — it is given an absolute path. Left undeclared, Vite discovers the import on the first page load and forces a full reload that destroys the execution context mid-measurement. React 18 projects have no such module and the entry is skipped.
- Resolution failure (plugin not resolvable from the project) → one stderr warning naming the package, and the run continues **without** the transform, with `Report.warnings` gaining the same text.
- `@vitejs/plugin-react` MUST appear in the plugins array **if and only if** the transform is active. Adding it unconditionally would change the JSX transform — and therefore every existing measurement — for all users. That is not acceptable as a side effect of this milestone.
- The plugins array is shared with M25: `@tailwindcss/vite` is loaded when the project uses it and stylesheets are injected. Both plugins coexist; Tailwind keeps its position first, the react plugin is appended. Neither loader may drop or replace the other's entries.

### K3 — overrides

- `--react-compiler` forces the transform on (error if the plugin cannot be resolved: `babel-plugin-react-compiler not found in <projectRoot>`, exit 2).
- `--no-react-compiler` forces it off, and wins when both flags are given — matching `--no-css`/`--css` and `--no-wrap`/`--wrap`.
- `AnalyzeOptions.reactCompiler?: boolean` — `undefined` means auto-detect.

### K4 — React analysis reinterpretation

- `ReactOptimizations` gains `compilerActive?: boolean`, set on every combo's result when the transform ran.
- When `compilerActive` is true:
  - `hasReactWarning` MUST NOT return true on `memoBailout` alone. Automatic memoization is the compiler's job, and a bailout finding under compilation is not actionable user code.
  - `memoBailoutComponents` is still reported, labelled as informational.
  - `contextFanOut`, `portalOrphans`, and `callbackIdentityDeltas` keep their current warning behavior — the compiler does not address any of them.
- `runReactAnalysis` writes its own `probe-entry.tsx` served from the same Vite server, so the transform applies to the probe automatically. This MUST be asserted, not assumed. The probe's own synthetic context provider assigns to `window` during render, which the compiler declines to compile, so the probe module carries no cache import of its own; the evidence is that the module goes through the plugin's babel pass (Fast Refresh markers) and that the component module it imports is compiled.

### K5 — reporting

- `Report.reactCompiler?: { active: boolean; detected: boolean; version?: string }` — `detected` is K1's package check, `active` is what actually ran, `version` from the resolved package's `package.json` when readable.
- `formatTable` prints `React Compiler: active (v<version>)` in the header block when active.
- When `detected` is true and the transform was disabled by flag (`--no-react-compiler`), `Report.warnings` MUST gain: `` `React Compiler is installed but disabled for this run; rerender costs will be higher than production.` `` This warning MUST NOT fire when the transform failed to resolve — K2's resolution warning already covers that case, and the two never both fire.

### K6 — measurement continuity

- Enabling the transform changes absolute timings. Baselines saved without it are not comparable. M29 (already landed) declares `EnvFingerprint.reactCompiler` with no producer; this milestone wires it: `saveBaseline` MUST record `reactCompiler: true` when the transform ran, omitted otherwise. A baseline saved without the field checked against a compiled run then classifies `incompatible` via `classifyEnv` (M29 E2) — no further invalidation logic here.

## Design notes

- `@vitejs/plugin-react` is the babel-based plugin; `@vitejs/plugin-react-swc` cannot host a babel plugin, so it is not an option. `^4.7.0` is pinned: its peer range is `vite: ^4.2.0 || ^5.0.0 || ^6.0.0 || ^7.0.0`, which covers the bundled Vite 6, and its `engines` floor (`>=16`) stays under the package's declared `node >= 20`. `@vitejs/plugin-react@5` would raise the floor to `^20.19.0 || >=22.12.0`; `@6` peers only on Vite 8.
- The plugin is imported dynamically inside the loader, not at module scope, so a run without the compiler never pays for loading `@babel/core`.
- The plugin also enables React Fast Refresh in dev and injects a preamble into every HTML document Vite serves. Both harness pages (`index.html`, `probe.html`) are Vite-served HTML, so both get the preamble; a module transformed by the plugin and loaded from a page *without* it throws at import time. This is why the transform is a server-wide plugin rather than a per-entry rewrite.
- Adding a babel pass slows the dev server's transform step. That cost is build-time, not measurement-time — the harness-ready gate absorbs it before any sample.
- Detection deliberately mirrors `detectNextJs` and `detectFramework` — same package.json read, same fallback discipline. Resolution mirrors `loadTailwindVitePlugin`: `createRequire` rooted at the project, import failure warns and degrades instead of aborting.
- The compiler's version is read by walking up from the resolved entry file to the first `package.json`, rather than resolving the `package.json` subpath, which an `exports` map may refuse.
- The memo-bailout reinterpretation is the user-visible half of this milestone. Without it, turning on the transform would fix the timings and leave the false warnings in place.

## Resolved questions

1. `compilerOptions` stays `{}`; `panicThreshold` is not exposed. The v1 default silently skips components it cannot compile, which is what Next does, and no fixture has needed a different setting.
2. Double-compilation does not arise: Vite does not transform `node_modules`, and the plugin's `include` covers project sources only. A component imported from a pre-built package reaches the browser as shipped.
3. `--compare-compiler` is not built. Measuring both ways doubles run time and is its own milestone.

## Known gaps

- The memo-bailout reinterpretation is verified as logic (`hasReactWarning`) and as wiring (`compilerActive` on every combo result), not as an observed change in the reported component list: `runReactAnalysis` currently collects no fiber data at all, because the DevTools hook `injectProfilerHook` installs never reaches the page. That is an M18 defect, independent of the compiler, and every finding it produces is empty today. The memoization the reinterpretation rests on is instead demonstrated directly, by counting child renders across a same-props rerender.

## Test plan

**Unit** (`test/unit/m27-compiler.test.ts`, `test/unit/m27-compiler-harden.test.ts`)
- `detectReactCompiler`: present in each of the three dependency sections; absent; missing package.json; malformed JSON; non-object section.
- Flag precedence: `--react-compiler` > detection, `--no-react-compiler` > detection, both → off, neither → detection.
- Resolution: the project's own `node_modules` wins; version read from the resolved package; missing, non-string and foreign-named manifests drop the version without dropping the path.
- Unresolvable plugin → the resolution warning on the state, run continues, `active: false`; forced on and unresolvable → throws `babel-plugin-react-compiler not found in <projectRoot>`.
- `hasReactWarning` with `compilerActive: true` and only `memoBailout` set → false; with `contextFanOut`, `portalOrphans` or a callback delta above 2 ms → true.
- `Report.reactCompiler` shape; the detected-but-disabled warning fires only on flag-disable, not on resolution failure; `formatTable` header line and the informational bailout label.
- `EnvFingerprint.reactCompiler` is `true` or omitted; `classifyEnv` marks a compiler-less baseline against a compiled run as `incompatible`.

Resolution-failure tests remove `NODE_PATH` for the duration of the call (`test/node-resolution.ts`): vitest points it at pnpm's hoisted store, which would otherwise resolve any installed package from any directory.

**E2E** (`test/e2e/compiler.test.ts`)
- Plugin assembly: the react plugin is present iff the transform is active; it coexists with M25's `@tailwindcss/vite` when both apply, and neither loader drops the other's entries.
- The served component module carries `react/compiler-runtime` when active and does not when inactive; the probe entry goes through the plugin's babel pass in the same run.
- Automatic memoization: a child whose only prop is an unchanged primitive re-renders on a same-props rerender without the transform and is skipped with it.
- Full pipeline: `Report.reactCompiler`, the disabled warning, `compilerActive` on every combo, and `EnvFingerprint.reactCompiler` recorded on save or omitted.
- A half-installed compiler warns once on stderr, keeps measuring, and carries the same text in `Report.warnings`; with `--react-compiler` it fails the run and leaves no harness directory behind.

Fixture projects live in `fixtures/compiler-project` and `fixtures/compiler-tailwind`, declared as pnpm workspace packages so they carry the real `babel-plugin-react-compiler` and `@tailwindcss/vite` in their own `node_modules`. The repo root deliberately does not declare either package: detection reads the project root, and every other fixture resolves its project root to the repo root.
