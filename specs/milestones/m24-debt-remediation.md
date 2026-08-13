---
kind: milestone
status: approved
tests: test/unit/, test/e2e/
---

# M24 — debt remediation (2026-07 audit)

Durable decisions:
- tsconfig via ts.readConfigFile + parseJsonConfigFileContent (extends chains/arrays, JSONC). Alias base = resolved baseUrl, else config dir. Multi-target paths: first target only (Vite alias limit). Missing → []; unparseable → [] + one stderr warn per config path per process.
- Export selection order: default export (declaration | `export default X;` | `export { X as default }`) > named export matching file stem case-insensitively > first PascalCase export in source order > filename guess. isDefaultOnly = importable as default import. Parse-only AST (createSourceFile, no program). Superseded old regex cascade (`function` > `const` regardless of order).
- detectFramework reads PROJECT package.json; missing/unparseable → "react".
- config/baseline root = nearest package.json ancestor of component. Pre-M24 baselines (dir-relative keys) not found — must re-save.
- Stale `.120fps-harness-*` dirs with mtime >1h swept best-effort before build (crash leftovers).
- Multi-path CLI: sequential, one component's failure doesn't abort the rest, exit 1 if any fail. JSON: per-component `120fps-report.<stem>.json`, stem collisions get -2/-3; explicit --json with multiple paths gets stem appended (M32 D1 made dirs expand to many components). Mutually exclusive with --fixture.
- page-errors: every waitForFunction(__120fps) site attaches capture; timeouts enriched with the underlying page exception (component throwing at import/mount names the real error, not a bare timeout). DEBUG=120fps prints stacks; missing-browser error appends `npx playwright install chromium` hint.
- Silent → loud: unsupported baseline version warn, missingInteractions warn, zero-props-extracted warning, profiler-durations-unavailable flag.
- Accepted debt: CDP `as any` casts (Playwright protocol typing gaps), untyped trace payloads.
- rapid-toggle 10→11 clicks: even count returns binary toggles to initial hash → M4 state discovery dead.
- e2e flake root causes: harness-ready timeout under 21-file parallel Chromium load → cap vitest maxForks; stale threshold assertions (rerenderMs 8→16); combo-fail assertions must exclude informational `__120fps_scaleN` combos.
