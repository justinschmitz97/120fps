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

## Purpose
.tsx path → extract props → build Vite harness → serve → Playwright opens → component renders.

## Contract
### MUST
- `extractProps(filePath)` → `PropSchema[]` from React component's props type
- Supported component patterns:
  - `export function X(props: P)` — named function
  - `export const X = (props: P) => ...` — named const
  - `export const X: React.FC<P> = ...` — FC-typed const (reads declared interface, not implicit children)
  - `export default function X(props: P)` — default-only
  - `export const X = React.forwardRef(...)` / `React.memo(...)` — single wrapper
  - `export const X = React.memo(React.forwardRef(...))` — nested HOC chains (recursive unwrap)
  - `export class X extends React.Component<P>` — class component (heritage clause type arg)
  - Intersection types, generics, discriminated unions, TS enums
  - Nested objects, `string | null`, template literals, readonly arrays, tuples
  - Large unions (22+ values) — stratified sampling caps at 64
  - All-optional props (includes all-undefined combo), default values in destructuring
  - Components extending HTMLAttributes — DOM props included, combos capped
  - Components with useEffect, zero-props components
- Type classification: bool→`[true,false]`, union→each variant, number→`[1,5,20]`, optional→includes `undefined`, function→noop, ReactNode→placeholder, Record→object, array→`[[],["item-1","item-2","item-3"]]`
- Imported type aliases resolved via Bundler moduleResolution
- `buildAndServe(filePath)` → Vite dev server with auto-detected import syntax
- Control API: `window.__120fps.mount(props)`, `.unmount()`, `.rerender(props)`, `.getContainer()`
- Concurrent `buildAndServe` calls work (separate temp dirs, random ports)
- CSS imports and sibling TS imports work (Vite handles them)

### MUST NOT
- No measurement (M2), no interaction discovery (M3)
- No manual scenario files, React only

### Invariants
- No user-provided Vite config needed
- Same React version as user's project (node_modules junction symlink)
- Bundler moduleResolution always (overrides user's tsconfig)

## Design

### Prop extraction (`src/prop-gen.ts`)
- `ts.createProgram` with Bundler moduleResolution
- `findComponentPropsType`: walks AST — function declarations, class declarations (heritage clause type args), variable statements with arrow/function initializers. `extractFunctionFromInitializer` recursively unwraps CallExpression chains.
- `classifyType`: strips `undefined` → ReactNode → call signatures → boolean → string/number literal unions → primitives → array → object → unknown

### Harness (`src/harness.ts`)
- `detectComponentExport`: regex-based `{ name, isDefaultOnly }`. Checks: `export function X`, `export const X` (with optional type annotation), `export class X`, then default patterns, then filename fallback.
- Generated `entry.tsx`: `import X from` (default) or `import { X } from` (named). No auto-mount — caller uses Control API.
- `HarnessResult` includes `componentPath` (absolute) for downstream modules
- Absolute component path (forward slashes on Windows)
- Project's `node_modules` symlinked via junction into harness temp dir
- Vite `createServer`, port 0, `fs.allow` includes project root

## Open
- Re-export detection (`export { X } from './internal'`) — not handled
- pnpm monorepo symlink stacking — untested
