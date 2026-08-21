---
kind: milestone
status: approved
tests:
  - test/unit/js-sibling-declaration-props.test.ts
  - test/unit/prop-extraction.test.ts
---

# M97: JavaScript components resolve like TypeScript ones

Lane B (+ I1 in Lane A). Closes material-ui-F1 and material-ui-F2.
Root cause: `C:\Projekte\120fps-fieldtest\verify\V3-material-ui.md`.

## Purpose

`packages/mui-material/src/Badge/Badge.js --explain-props` reported a two-prop contract,
`ref` and `key`, for a component whose own sibling `Badge.d.ts` declares sixteen. The same
two-prop result came back for `Chip.js`, `Tabs.js` and `Autocomplete.js` — every published
React library that ships `.js` implementations beside `.d.ts` declarations, which is most of
them. The reported props were not merely incomplete: `ref` and `key` are React's own ambient
attributes and are not props of the component at all, so the run measured two identical
empty-props mounts and presented them as prop sensitivity
(`findings/material-ui.md`, run 7: `combos[0].props === {}`, `combos[1].props === {}`).

## Contract

- inputs: a component entry path, its directory, the project's compiler options.
- outputs: `PropsExtraction.schemas` for that entry, plus warnings naming any resolution failure.
- constraints: TypeScript Compiler API only (ADR 0002); no runtime evaluation; no edit to the
  measured repository.
- non-goals: prop *ranking* (M103), Vue extraction (M98), the JSX-in-`.js` transform (I1, Lane A).

### MUST (from `specs/milestones/M97-M106-MAP.md`, refined)

- A `.js`/`.jsx` component with a sibling `.d.ts` (or a `types`/`typings` entry resolving to one)
  takes its props from the declaration: resolve `./<stem>` through `ts.resolveModuleName` and read
  the exported component's type before falling back to the JS binding (`prop-gen.ts:788-796`, the
  call-signature-of-the-variable's-type fallback).
- A bound props type whose only properties are React ambient attributes (`ref`, `key`, or empty) is
  treated as unresolved: the fallback chain continues, and when nothing better exists the schema is
  empty with a warning naming the binding and why (`UNTYPED_JS_COMPONENT_WARNING`), never
  `ref`,`key` presented as the contract.
- ADR 0002 is amended (append-only, new ADR 0004 with `supersedes:`): "untyped JS components:
  default props only" applies to JS without any declaration; JS with a sibling declaration is typed.

### MUST NOT

- Change TypeScript extraction results for `.ts`/`.tsx` entries (pinned by the existing fixtures in
  `test/unit/prop-extraction.test.ts`).
- Read a declaration for a `.ts`/`.tsx` entry. A TypeScript entry's own source is the contract; a
  generated `.d.ts` beside it would only ever be a stale copy.

## Design

### 1. React's ambient attributes are not a resolution

`looksLikePropsType` (`src/prop-gen.ts`) already rejects an empty type. It now also rejects a type
whose every property is one of React's ambient attributes — `ref` (`RefAttributes`) and `key`
(`Attributes`) — declared in React's own type packages. That is the exact shape
`React.forwardRef<T, P = {}>` degrades to when the render function's first parameter carries no
annotation: `ForwardRefExoticComponent<RefAttributes<any>>`, whose first call signature's parameter
is `RefAttributes<any>` (V3, "type of Badge symbol"). The check is name-based *and*
origin-based: a component that genuinely declares a prop called `ref` or `key` in its own file is
not affected, because that property's declaration is not inside `@types/react`.

Rejecting the type at `looksLikePropsType` rather than at one call site means every binding path
gets the same bar — the parameter path, the class heritage path and the type-level fallback.

### 2. The sibling declaration

`BoundProps` records `viaTypeFallback` at the one site the MUST names (`prop-gen.ts:788-796`: the
loop over `checker.getTypeAtLocation(...).getCallSignatures()`), and `PropsBinding` carries it out
of `findComponentPropsType`. `extractProps` consults the sibling declaration when the entry is a JS
file and the binding is either absent or came from that fallback — literally "before falling back to
the JS binding", while a JS component whose *parameter* is typed keeps binding from its own source.

Resolution is `ts.resolveModuleName("./<stem>", <entry>, options, ts.sys)`, the same call every
importer of `./Badge` makes. It answers both halves of the MUST: a sibling `Badge.d.ts`, and a
directory whose `package.json` `types`/`typings` names one. A result that is not a `.d.ts`, or that
is the entry itself, is not a declaration and is ignored.

The declaration file is added as a second program root so its symbols bind. The exported component
is picked in this order, first hit wins:

| rank | export | why |
|---|---|---|
| 1 | `default` | the published entry point; MUI's `export default Badge` |
| 2 | the export whose name normalizes to the file stem | a named-only declaration (`export { Badge }`) |
| 3 | the first export whose type has call signatures | a single-component declaration named otherwise |

The chosen symbol's type is alias-resolved, its first call signature's first parameter is read, and
`looksLikePropsType` decides. For MUI's `OverridableComponent<BadgeTypeMap<'span', {}>>` the first
signature is `<C extends ElementType>(props: { component: C } & OverrideProps<M, C>)`, which yields
the sixteen props V3 measured.

### 3. The empty JS schema is disclosed

`UNTYPED_JS_COMPONENT_WARNING` fires when a JS entry extracted no schemas and no declaration
supplied one. It names the binding (the target's name and the entry), says the JS source carries no
props type and no sibling declaration was found, and points at the `<stem>.props.tsx` escape hatch —
the same register as `VUE_OPTIONS_API_PROPS_WARNING`. `isUntypedJsComponentWarning` lets
`src/analyze.ts` recognize it, so the generic `ZERO_PROPS_WARNING` ("extraction may have failed")
does not stack on top of a stated cause. Lane C owns `analyze.ts`; the predicate is exported for it.

### 4. One message stopped being true

`warnUnboundTarget` ("could not resolve props for X ... Another declaration in this file has props")
was emitted inside `findComponentPropsType`, one step before the declaration lookup exists. On MUI's
Badge.js it printed alongside a complete sixteen-prop schema. The condition is now returned as
`PropsBinding.unboundTargetHijacked` and reported by `extractPropsDetailed` only after the
declaration has also come up empty (M92's rule: every printed message is true of its run).

## Deviations from the map

- The map's fallback ordering is honored through `viaTypeFallback` rather than by moving code into
  `bindProps`, which has neither the entry path nor the program.
- `PageErrorSummary`, named in the map's I4, does not exist; that interface is recorded in M99.

## Open questions

None.

## Verification

### Unit

`pnpm vitest run test/unit/js-sibling-declaration-props.test.ts` — 11 passed. Fixture
`fixtures/js-with-dts/`: `Badge.js` + `Badge.d.ts` (MUI's `OverridableComponent` shape),
`PlainDefaults.js` (destructuring defaults, no declaration), `Bare.js` (untyped parameter),
`WrappedNoTypes.js` (unannotated `forwardRef`, no declaration). The MUST NOT is pinned by two
temp-project cases: a `.tsx` with a stale `.d.ts` beside it keeps its own props, and a component that
declares its own `ref` prop keeps it.

`pnpm vitest run test/unit/ --maxWorkers=4 --reporter=dot` — 236 files, 3858 passed, 1 skipped,
105.69 s. No existing TypeScript extraction result changed.

### Real repository — material-ui @ d818ecb

`cd /e/repositories/material-ui && node /c/Projekte/120fps/dist/cli.js
packages/mui-material/src/Badge/Badge.js --explain-props`
(`logs/fix-b-mui-badge-explain.log`, exit 0). Before: `Props (2): ref, key`. Now:

```
Props (16):
  component     unknown    required  (no values)  [degenerate: no value can be enumerated from RootComponent]
  color         union      optional  "primary", "secondary", "default", "error", +3 more
  invisible     boolean    optional  true, false
  overlap       union      optional  "rectangular", "circular"
  showZero      boolean    optional  true, false
  variant       union      optional  "standard", "dot"
  anchorOrigin  object     optional  {"vertical":"bottom","horizontal":"left…
  badgeContent  reactnode  optional  (no values)
  children      reactnode  optional  (no values)
  classes       object     optional  {"root":"text","badge":"text","dot":"te…
  className     string     optional  "test"
  max           number     optional  1, 5, 20
  sx            function   optional  (no values)
  slots         object     optional  {"root":"symbol","badge":"symbol"}
  slotProps     object     optional  {"root":{"component":"symbol","sx":{"cl…
  style         object     optional  {"accentColor":{},"alignContent":"cente…
```

Neither `ref` nor `key` appears, and no `warnUnboundTarget` line is printed.

`... packages/mui-material/src/Chip/Chip.js --samples 3 --max-combos 2 --explore-budget 20`
(`logs/fix-b-mui-chip.log`, exit 1 on a hostile-machine budget verdict, not a crash;
`grep -c "React is not defined"` → `0`). The run reaches a report with real props:

```
Mode: prop combos (2 measured of 64 generated, +4 scale probes)
0    11.50ms      9.28ms       1.25ms       4        0              -              WARN (T1) [5 page errors]
1    8.82ms       5.31ms       0.88ms       4        1              -              WARN (T1)
Prop Deltas (top 5):
  disabled: false → true     mount -4.51ms  rerender -2.42ms
```

The JSX-in-`.js` half is Lane A's I1, verified landed in `dist` for this run
(`src/harness.ts:2112-2116`, `jsx: "automatic"`).

Cleanup: `find . -maxdepth 6 \( -name "120fps-report*.json" -o -name ".120fps-harness-*" \)`
→ empty; `git status --porcelain` → empty.
