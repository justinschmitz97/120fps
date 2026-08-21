---
kind: milestone
status: draft
tests:
  - test/unit/own-props-outrank-inherited.test.ts
  - test/unit/prop-default-disclosure.test.ts
  - test/unit/prop-cap-ranking.test.ts
---

# M103: the measured props are the component's own

Lane B (+ I8, I9). Closes chakra-ui-F1, heroui-F3, dub-F7, heroui-F2, calcom-F2 (I8), base-ui-F3.
chakra-ui-F2 is I9 (Lane A). Evidence: `findings/chakra-ui.md`, `findings/heroui.md`,
`findings/dub.md`, `findings/calcom.md`, `findings/base-ui.md`.

## Purpose

`packages/react/src/components/badge/badge.tsx --explain-props` on chakra listed 32 props of which
zero were Badge's: `htmlTranslate`, `popover`, `unselectable`, `itemScope`, `onCopy`, `onCut`,
`onPaste`, `onComposition*` — the surface every `<span>` in every library shares.
`colorPalette`, `size` and `variant`, the three the badge recipe defines, never appeared. Same
shape on tabs (1077 props), select (1078), combobox (1078). On heroui, `--explain-props` on
`badge.tsx` named `BadgeRoot` in its header and bound `BadgeAnchor`'s props (line 33), so
`children` printed `required` when `BadgeRootProps.children` is optional and
`color`/`placement`/`size`/`variant` were not in the type at all. On dub, `--matrix` crossed
thirteen inherited `<span>` attributes and left out `variant`, Badge's only own prop.

## Contract

- inputs: a component entry, its props type, the 32-prop cap.
- outputs: which props are kept and in what order, what type each carries, and each prop's default.
- constraints: MAX_PROPS stays 32; extraction itself is unchanged.
- non-goals: matrix cell selection (I10, same lane, separate change), the export the *harness*
  mounts (I9, Lane A).

### MUST (from the map, refined)

- The 32-prop measurement cap fills from the component's own declared props first: props declared in
  the component's own file or its local type aliases outrank inherited DOM attributes and event
  handlers, and a literal-union prop outranks an unknown-typed one.
- `findComponentPropsType` binds the props of the export actually measured: for heroui `badge.tsx`,
  `BadgeRoot` (line 67, `children` optional), not `BadgeAnchor` (line 33, `children` required).
- Literal-union props reached through a generic or an intersection are typed as unions with their
  values (heroui `color` must not be `unknown`).
- `detectScalingProps` does not auto-activate curve mode on numeric props whose name denotes a bound
  or step.
- `PropSchema.defaultValue` per I8.

### MUST NOT

- Change which props are *extracted*; only ranking, binding and typing.

## Design

### 1. Why M86's Tier-0 missed these

Tier 0 is `sourceReferencedPropNames(fn) ∪ presetPropNames(file)`. Both repositories defeat the
first half, for different reasons, and neither had a preset:

- **chakra** — `badge.tsx:18` is `export const Badge = withContext<HTMLSpanElement, BadgeProps>("span")`.
  There is no render function anywhere in the file, so `extractFunctionFromInitializer` returns
  nothing, `bindProps` falls to the type-level path, `binding.fn` is `undefined`, and
  `sourceReferencedPropNames` scans an empty set. Tier 0 was therefore empty by construction, and
  nothing else in the rank table looked at *where* a prop is declared before it looked at its shape.
- **heroui** — `BadgeRoot` does destructure `children, className, color, placement, size, variant`
  (`badge.tsx:65-72`), so Tier 0 would have promoted all six. It never ran on `BadgeRoot`:
  `selectTargetCandidate` picked `BadgeAnchor` (see 2 below), whose own body destructures only
  `children` and `className`, and whose props type does not contain the other four at all. A prop
  absent from the bound type cannot be ranked into anything.

The deeper cause is shared and is what MUST 1 fixes: M81's Tier 1 is *shape only*. An inherited
`translate?: "yes" | "no"` and an inherited `hidden?: boolean` are literal-union and boolean, so
they were Tier 1 — ahead of every one of the component's own props whose type resolves to something
less tidy. thirteen such attributes exist on `HTMLAttributes` alone, and `children` plus the ~90
`on*` handlers filled Tier 2 ahead of anything declared locally but not variant-shaped.

### 2. The rank table

Origin decides before shape. Rank 0 is best; ties keep declaration order, unchanged.

| rank | condition | example |
|---|---|---|
| 0 | promoted: the component's own body references the name, or a `<stem>.props.tsx` names it | ant-design `onClick` |
| 1 | declared outside `node_modules` (own file, local type alias, the package's generated types) **and** variant-shaped (boolean or finite literal union) | heroui `variant` |
| 2 | declared outside `node_modules`, any other shape — including `unknown` from an unresolved generic | chakra `colorPalette` |
| 3 | no declaration site at all (a mapped/computed member) | `RecipeProps<"badge">` members |
| 4 | declared only inside `node_modules` and variant-shaped | inherited `translate`, `hidden` |
| 5 | declared only inside `node_modules`, named `children` or `/^on[A-Z]/` with a call signature | `onCopy` |
| 6 | everything else | inherited `nonce` |

Required props still bypass the cap entirely (M86): a missing required prop is a guaranteed crash.
Rank 3 sits above the inherited ranks because a member with no declaration site cannot be shown to
be third-party, and it is exactly the shape a recipe/variant type produces.

### 3. The bound export is the measured export

`detectComponentExport` (`harness.ts`) decides what the harness mounts, from `scanExports`'s order:
default, then a stem match, then the first export whose name does not end in `Provider`, then the
first. `selectTargetCandidate` (`prop-gen.ts`) decides what extraction binds, from
`collectComponentCandidates`'s *declaration* order: default, then a stem match, then `exported[0]`.
For heroui's `badge.tsx` the two disagree — `scanExports` reports `BadgeRoot, BadgeLabel,
BadgeAnchor`, declaration order is `BadgeAnchor(33), BadgeLabel, BadgeRoot(67)` — so the header named
one component and the table described another.

`scanExports` already lives in `prop-gen.ts` (`harness.ts` imports it from here). The selection
order moves next to it as `selectMeasuredExport(exports, fileName, target?)`, and
`selectTargetCandidate` consults it before falling back to `exported[0]`. The two answers then come
from one function over one export list.

### 4. Defaults (I8)

`PropSchema.defaultValue?: unknown` and `defaultSource?: "destructuring" | "withDefaults" |
"defaultProps"`. Three readers, all parse-only, all literal-valued (a non-literal default is not
recorded rather than guessed):

- `destructuring` — the bound function's first parameter's object binding pattern
  (`{ loading = false, color = "primary" }`, calcom `Button.tsx:226-229`).
- `withDefaults` — the Vue `withDefaults(defineProps<T>(), {...})` object `applyWithDefaults`
  already reads; it moved the default to the front of `values` without ever naming it as one.
- `defaultProps` — a same-file top-level `<Target>.defaultProps = { … }` assignment.

Lane C prints a `default` column when any prop carries one (`formatExplainProps`).

### 5. Curve mode and numeric bounds

`detectScalingProps` matched `max` on Base UI's `NumberFieldRoot` purely on the name, then the run
itself reported that the DOM node count never changed. `SCALING_BOUND_NAME` excludes `min`, `max`,
`step`, `largeStep`, `smallStep`, `precision`, `decimalScale`, `tabIndex`, `zIndex`, `maxLength`,
`minLength`, `maxWidth`, `minWidth`, `maxHeight`, `minHeight` — names that denote a bound or a step
rather than a quantity of rendered things. An array prop is unaffected: only the two numeric
branches consult the list.

## Verification

(filled in by the run)
