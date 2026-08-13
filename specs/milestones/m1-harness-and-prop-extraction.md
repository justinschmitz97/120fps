---
kind: milestone
status: done
tests:
  - test/unit/prop-extract.test.ts
  - test/unit/prop-gen.test.ts
  - test/unit/stress.test.ts
  - test/unit/stress2.test.ts
  - test/e2e/harness.test.ts
  - test/e2e/stress.test.ts
  - test/e2e/stress2.test.ts
---

# M1 — harness + prop extraction

.tsx → extractProps (TS Compiler API) → Vite harness → Control API `window.__120fps.mount/unmount/rerender/getContainer`.

Non-obvious:
- Bundler moduleResolution ALWAYS — overrides user tsconfig.
- Same React as user project via node_modules junction symlink; `resolve.dedupe` react/react-dom.
- HOC chains `memo(forwardRef(...))` unwrapped recursively; class components via heritage-clause type arg; `React.FC<P>` reads declared interface, not implicit children.
- Large unions: stratified sampling caps combos at 64.
- No user Vite config, no auto-mount (caller drives Control API), concurrent servers ok (temp dirs, port 0).

Open: re-export `export { X } from './internal'` unhandled; pnpm monorepo symlink stacking untested.
