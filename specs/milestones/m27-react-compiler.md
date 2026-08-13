---
kind: milestone
status: approved
tests: test/unit/m27-compiler.test.ts, test/unit/m27-compiler-harden.test.ts, test/e2e/compiler.test.ts
---

# M27 — React Compiler awareness

Unprofiled compiler = pessimistic timings + false memo-bailout warnings. Detection: `babel-plugin-react-compiler` in project package.json deps — the ONLY signal (next.config.* not parsed: executable, can be TS). Installed-but-disabled projects get profiled WITH compiler (accepted; `--no-react-compiler` escape, wins over `--react-compiler`; forcing on with unresolvable plugin → exit 2).

Non-obvious:
- `@vitejs/plugin-react` is OUR dependency, pinned ^4.7.0 (peers cover bundled Vite 6, engines under node≥20; v5 raises node floor, v6 peers Vite 8; -swc variant can't host babel). Compiler itself resolved from the PROJECT's node_modules — version matches production. Dynamic import — compiler-less runs never load @babel/core.
- Plugin in plugins array IFF transform active: unconditional add would change the JSX transform (and thus every measurement) for all users.
- `react/compiler-runtime` must be pre-declared in optimizeDeps.include when active: plugin only pre-bundles it when it recognizes the babel plugin by bare NAME, and we pass an absolute path. Undeclared → Vite discovers on first load → full reload destroys execution context mid-measurement. React 18 lacks the module — skip entry.
- Fast Refresh preamble goes into every served HTML; a transformed module on a preamble-less page throws ⇒ transform must be server-wide, not per-entry. Probe entry goes through the babel pass automatically (asserted, not assumed; probe's provider assigns to window during render so compiler declines it — no cache import of its own).
- compilerActive → memoBailout is INFORMATIONAL, never warns (compiler's job); contextFanOut/portalOrphans/callback deltas keep warning — compiler addresses none of them.
- Version read by walking UP from resolved entry file to first package.json (exports map may refuse the package.json subpath).
- detected + flag-disabled → "rerender costs higher than production" warning; never co-fires with the resolution-failure warning.
- Fingerprint: reactCompiler:true when transform ran, omitted otherwise — pre-wiring baselines stay comparable; cross-state check → incompatible (M29).
- Coexists with @tailwindcss/vite (tailwind first, react appended; neither loader drops the other).
- Tailwind/babel transform cost is build-time — harness-ready gate absorbs it pre-sample.
- Test infra: resolution-failure tests must strip NODE_PATH (vitest points it at pnpm's hoisted store, which resolves anything from anywhere). Compiler fixtures are pnpm workspace packages carrying real deps; repo root deliberately lacks them.
- Historical (fixed since): at M27 time injectProfilerHook never reached the page (missing Page.enable, an M18 defect), so memo reinterpretation was verified as logic + by counting child renders, not via fiber data.

Rejected: compilerOptions/panicThreshold exposure (v1 default silently skips uncompilable, like Next); `--compare-compiler` (doubles runtime, own milestone). Double-compilation non-issue: Vite doesn't transform node_modules.
