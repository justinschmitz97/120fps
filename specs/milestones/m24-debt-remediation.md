---
kind: milestone
status: approved
tests: test/unit/, test/e2e/
---

# M24 — debt remediation

## Purpose

Fix internal debt found in the 2026-07 audit: duplicated tsconfig/export-detection logic, dead CLI surface, silent degradations, opaque failure modes, config/baseline root mismatch, packaging and spec drift. No new product features.

## Non-goals

- Multi-component CLI runs, globs, directory scans.
- Provider/decorator wrapper (`--wrap`), CSS injection (`--css`).
- React Compiler transform in harness, next-intl/react-hook-form shims.
- Vite 7/8 or TypeScript 6 dependency upgrades.
- Milestone spec archiving, git tagging, npm publish.

## Contracts

### D1 — tsconfig reading unified on TS API (harness)

- `loadTsconfigAliases(projectRoot)` MUST read `<projectRoot>/tsconfig.json` via `ts.readConfigFile` + `ts.parseJsonConfigFileContent` (resolves `extends` including arrays, JSONC, trailing commas). No upward walk beyond projectRoot (unchanged lookup location).
- Alias base dir MUST be the resolved `baseUrl` when set, else the directory of the config file that is being parsed (`pathsBasePath` when available).
- Multi-target `paths` entries: first target only (Vite alias limitation) — unchanged, now documented.
- Missing tsconfig → `[]`. Unparseable tsconfig → `[]` plus one stderr warning (`stripJsonComments` hand-parser is deleted).
- MUST NOT change the returned alias shape `{ find: RegExp, replacement: string }`.

### D2 — export detection unified on AST (harness + prop-gen)

- `extractExports` MUST additionally recognize `export default <Identifier>;` (ExportAssignment) and `export { A, B as default }` (ExportDeclaration), and MUST be parse-only (`ts.createSourceFile`, no `createProgram`) — same async signature.
- `detectComponentExport(filePath)` MUST be reimplemented on the same AST walker. Selection order:
  1. default export (declaration, assignment, or `as default` clause);
  2. named export whose name matches the file stem case-insensitively;
  3. first component-cased (PascalCase) export in source order;
  4. fallback: filename-derived guess, assume default (unchanged).
- `isDefaultOnly` semantics: true iff the chosen component is importable as a default import. The generated entry MUST import default vs named consistently with this flag (verify against `export { X as default }` — the entry must use a default import there).
- Existing tests that encoded the old regex-cascade form priority (`function` > `const` regardless of source order) are superseded by this contract; update them.

### D3 — `--no-isolate` wired

- `--no-isolate` MUST disable isolation even when `--isolate <phases>` is present (explicit disable wins). Without `--isolate` it remains a no-op.
- Help text: "Disable isolation mode (overrides --isolate)".

### D4 — `detectFramework` measures the project, not our own entry

- New contract: `detectFramework(projectRoot: string): "react" | "vanilla"` — returns `"react"` iff `react` or `react-dom` appears in dependencies/devDependencies/peerDependencies of `<projectRoot>/package.json`; missing or unparseable package.json → `"react"` (preserves prior effective behavior).
- `analyze()` MUST pass the project root (not generated entry content). CLI `--framework react|vanilla` override precedence unchanged.

### D5 — failure diagnostics (page errors)

- New module `src/page-errors.ts`:
  - `attachPageErrorCapture(page): PageErrorCapture` — collects `page.on("pageerror")` messages and `console` messages of type `error` (buffer cap 20).
  - `PageErrorCapture = { errors: string[]; summary(): string }`.
  - `enrichTimeoutError(err: unknown, capture: PageErrorCapture, context: string): Error` — when `err` is a timeout waiting for the harness global, returns an Error whose message names the context and includes captured page errors; otherwise returns `err` unchanged (wrapped as Error).
- Every `waitForFunction(window.__120fps…)` site (`analyze.ts`, `measure.ts` ×2, `explorer.ts`, `react-profiler.ts`) MUST attach capture and rethrow enriched. A component that throws at import or mount MUST produce an error message containing the underlying exception text, not a bare Playwright timeout.

### D6 — silent degradations become loud (non-fatal warnings on stderr unless stated)

- tsconfig read/parse errors in `prop-gen` (`configFile.error`, `parsed.errors`) → warn once per config path per process; behavior otherwise unchanged.
- `loadBaseline` with `version !== 1` → warn ("unsupported baseline version, ignoring") and return null.
- `compareBaseline`: interactions present in baseline but absent from the current run MUST be reported via new additive field `BaselineComparison.missingInteractions: string[]`; CLI prints them as warnings (never FAIL).
- Zero props extracted (non-fixture, non-composed path) → `Report.warnings: string[]` (new additive field) gets a hint that extraction may have failed; terminal output prints warnings.
- React profiler snapshots with fibers but all-zero/undefined `actualDuration` → additive flag surfaced in report ("profiler durations unavailable") instead of silently attributing 0ms.
- CLI catch: `err: unknown`; if `process.env.DEBUG` contains `120fps`, print stack. If the message matches Playwright's missing-browser error, append hint `npx playwright install chromium`.

### D7 — config/baseline resolved from the package root

- Project root for `120fps.config.json` and `120fps-baseline.json` MUST be the nearest ancestor directory of the component containing `package.json` (reuse harness `findProjectRoot`, now exported); fallback: component dir.
- Baseline/config keys: `"./" + posix(relative(projectRoot, component))`.
- Migration guard: when `--check` finds no baseline at the project root but a legacy `120fps-baseline.json` exists next to the component, warn and suggest `--save-baseline`.
- Consequence (accepted): baselines saved pre-M24 with directory-relative keys are not found; re-save.

### D8 — stale harness dirs swept

- `buildHarness` MUST delete `.120fps-harness-*` directories in the project root whose mtime is older than 1 hour (crash leftovers), best-effort, before creating a new one.

### D9 — typing hygiene

- `CompositionNode` gets a typed `text` (no `(props as any).text` in `nodeToJsx`).
- Accepted as-is (documented, not fixed): CDP `as any` casts for methods missing from Playwright's typed protocol; untyped trace-event payloads in metrics.ts.

### D10 — packaging

- `package.json`: `exports` lists `types` before `import`; `files: ["dist"]`.
- `.gitignore`: harness dir pattern matches the real prefix (`.120fps-harness-*/`); `120fps-verify.json` ignored; tracked report artifacts removed from the index.
- README: CLI section lists all implemented flags (source of truth: `printHelp()`); Requirements section states Chromium-via-Playwright requirement and the `npx playwright install chromium` fallback.

### D11 — spec sync

- `00-tdd.md`: stale/contradictory per-milestone test totals replaced by a single current suite count; M18 framework-detection description matches D4; M23 `--no-isolate` matches D3; module table gains `page-errors`.
- `specs/README.md` and `CLAUDE.md`: remove the nonexistent `specs/packages/` kind/row (or create it — not created in M24).
- `m18`, `m22`, `m23` milestone specs updated where contracts changed.

### D12 — multi-component paths (implements the unfulfilled M22 promise)

- `120fps A.tsx B.tsx …` MUST measure each component sequentially, print each report, and exit 1 if ANY component fails (exit 2 on usage errors as before). Single-path behavior unchanged.
- Baselines: one file at the project root, one entry per component (D7 keys) — already the M22 contract.
- JSON output: single path → `--json`/default unchanged. Multiple paths → default per-component file `120fps-report.<stem>.json`; stem collisions within one invocation get `-2`, `-3`… suffixes in path order. An explicit `--json` with multiple paths is a usage error (exit 2, ambiguous).
- A failure to profile one component (exit-2-class error) MUST NOT abort the remaining components; it is reported per component and the process exits 1.
- Mutually exclusive with `--fixture` (fixture targets exactly one component).

### D13 — pre-existing e2e failures repaired (all confirmed present at pre-M24 HEAD via worktree run)

- **rapid-toggle parity bug (product)**: `type === "click"` dispatched `rapid-toggle-11` — an even click count returns every binary toggle to its initial DOM state, so the explorer's post-interaction hash equals the initial hash and state transitions are never discovered (M4 contract broken; `test/e2e/explorer.test.ts`, `explorer-harden.test.ts` H4 failing). Fix: the pattern is now **`rapid-toggle-11`** — 11 clicks; the odd count leaves binary toggles in the flipped state so state discovery works. All name/count references updated (code, tests, specs).
- **Stale rerender e2e**: asserted the pre-v0.1.7 `rerenderMs` default (8); v0.1.7 retuned it to 16. Test now asserts `DEFAULT_THRESHOLDS.rerenderMs`.
- **Stale analyze thresholds e2e**: `combos.every(fail)` predates M12-era auto-scale combos, which are informational and forced `"pass"`. Test now excludes `__120fps_scaleN` combos.
- **measure e2e flake**: harness-ready 30s timeout exceeded under 21-file parallel Chromium load (passes in isolation). Fix: cap vitest workers (`poolOptions.forks.maxForks`) in `vitest.config.ts`.

## Test plan

Unit: new/updated tests per contract in `test/unit/` (tsconfig fixtures incl. `extends` chain/array, export forms incl. `export default X;` and `as default`, selection order, `--no-isolate` wiring, `detectFramework` from package.json fixtures, baseline version warning, `missingInteractions`, root resolution, stale-dir sweep). E2E: page-error enrichment (component that throws at import/mount produces the underlying message). Full suite green before docs sync.
