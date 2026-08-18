---
kind: milestone
status: implemented
tests:
  - test/unit/m58-prop-target-binding.test.ts
  - test/unit/m58-prop-target-harden.test.ts
---

# M58 — prop extraction binds to the target component

## Purpose

`extractProps` walked a file's top-level declarations in source order and kept
the first declaration whose first parameter looked like a props type. Nothing
tied that declaration to the component the harness imports and renders. Any
internal helper declared above the exported component therefore supplied the
schema: six components across four dogfooded projects measured a helper's props
(`CanvasArea`, `ThumbIcons`, `SparkParticle`, `Marker`, `FileTypeIcon`) while
the report presented them as the target's. Downstream everything inherits the
error — combos, delta pairs, matrix cells and hints describe props the rendered
component does not accept, and `--curve` finds no array prop because the real
one is masked, so it silently degrades to prop-combo mode.

Report naming had the same root: `detectComponentName` (analyze.ts) matched
export forms with regexes and fell back to a title-cased filename, so
`health-check.tsx` reported `Health-check` while the file exported
`FoodHealthCheck`.

## Contract

- Props MUST be resolved against a *target component*, selected among the
  file's top-level component declarations in this order:
  1. the default-exported component (`export default function F`,
     `export default F`, `export { F as default }`, and `export default memo(F)`
     — the wrapper chain is followed to the identifier behind it);
  2. the exported component whose local name — or the name it is exported
     under, `export { Core as AliasWidget }` — matches the file stem after
     dropping non-alphanumerics and lowercasing both sides (`hotspot-image.tsx`
     → `HotspotImage`);
  3. the first exported component in source order.
- A non-exported declaration MUST NOT supply the schema while any exported
  component exists in the file. When no component is exported, the first
  component declaration stays the target (fixtures and scratch files).
- The target's props type MUST be read through these declaration forms:
  `function F(props: P)`, `const F = (props: P) => …`, `const F: FC<P> = …`,
  `class F extends Component<P>`, call wrappers (`memo`, `forwardRef`, nested)
  around a function *expression* or around an *identifier* naming a local
  declaration, `export default F` / `export { F as default }` naming an
  earlier declaration, and a default export whose expression wraps a component
  declared in another module (`export default memo(Imported)`).
- Self-consistency guard: when the target's declaration destructures its first
  parameter and the resolved props type shares no key with that destructuring,
  another candidate whose props type does overlap it MUST be preferred.
- When a target is resolved but no props type can be bound to it while another
  declaration in the file does have one, extraction MUST return `[]` and warn
  on stderr naming the target and the file. Silently returning the other
  declaration's schema is forbidden. A target that declares no parameter is a
  propless component, not a failure, and MUST NOT warn.
- `report.componentName` MUST be the resolved export name — the same name the
  harness imports and renders (`detectComponentExport`) — with the title-cased
  filename remaining only as the last fallback.
- MUST NOT: change Vue extraction (`defineProps` path), auto-scaling prop
  detection, `extractAllProps`/`extractExports` results for files that already
  produced them, or any report shape.

## Design

- `findComponentPropsType` collects *candidates* first (name, declaration,
  exported, isDefault, source order) and resolves the target afterwards, so
  selection is a decision over the whole file rather than an accident of walk
  order. Export status comes from the same three sources `scanExports` reads:
  modifiers, `export default <Identifier>`, and `export { … }` clauses.
- Props for a candidate are read from its own first parameter
  (`checker.getTypeAtLocation`), which keeps `const F: FC<P>` working through
  contextual typing. Call wrappers are unwrapped by the existing
  `extractFunctionFromInitializer`; when the unwrapped argument is an
  identifier (`memo(Inner)`), the identifier is followed to its local
  declaration in the same file, capped at 8 hops so a cyclic alias cannot spin.
  What neither step reaches — `const F: FC<P> = anything`, a default export of
  an imported component — is read off the value's own call signature, so the
  type checker covers the cases the AST cannot see.
- The default-export statement is itself a candidate. When it names a local
  declaration that declaration is pushed first and wins selection; when it
  names something imported, the statement stays the only target, which keeps a
  local helper out of the schema.
- The self-consistency guard compares the props type's keys against the
  binding names of the target's destructured parameter (property name before
  renaming, rest elements ignored). It is a repair path, not a filter: with a
  correct binding the sets always overlap, so it only fires when the follow
  step lands on the wrong declaration.
- `detectComponentName` delegates to `detectComponentExport`, which is what the
  harness already uses to pick the rendered component. One resolver, one name:
  report and harness cannot disagree.

## Notes

- `extractAllProps` keeps its own per-export walk: it answers "props of every
  exported component" for composition, where there is no single target.
- The harness's stem rule (`detectComponentExport`, harness.ts) compares the
  raw lowercased stem, so it does not normalize `hotspot-image` to
  `hotspotimage`. Both resolvers agree except for a file that has no default
  export, two or more exported components, and a stem that only matches after
  normalization; there the harness renders its first export while the schema
  describes the stem match. Sharing this milestone's resolver with
  `detectComponentExport` closes that window.
