---
kind: milestone
status: approved
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

Origin decides before shape, and *width* of the declaration site decides within origin. Rank 0 is
best; ties keep declaration order, unchanged. Required props bypass the cap entirely (M86): a missing
required prop is a guaranteed crash.

`WIDE_DECLARATION_MEMBERS = 40` is the width gate. A component's own props interface is small
(heroui's `BadgeRootProps` has six members); a DOM attribute surface (`HTMLAttributes`, ~250) and a
style system's generated CSS-property surface (chakra's `SystemProperties`, ~300) are not.
"Declared in the project's own sources" alone does not separate chakra's three recipe props from the
three hundred style props declared beside them in the same package — `isNarrowDeclarationSite` reads
the member count of the `interface` / `type` literal / class that declares the prop, and treats a
prop with no such parent as narrow.

| rank | condition | example |
|---|---|---|
| 0 | promoted: the component's own body references the name, or a `<stem>.props.tsx` names it | ant-design `onClick` |
| 1 | declared outside `node_modules` in a **narrow** site, variant-shaped (boolean or finite literal union) | heroui `variant` |
| 2 | declared outside `node_modules` in a narrow site, any other shape | heroui `className` |
| 3 | no declaration site at all — a mapped or computed member | `RecipeProps<"badge">` members |
| 4 | declared outside `node_modules` in a **wide** site, variant-shaped | chakra `translate` (its own style surface) |
| 5 | declared outside `node_modules` in a wide site, any other shape | chakra `_hover` |
| 6 | declared only inside `node_modules`, variant-shaped | inherited `hidden` |
| 7 | declared only inside `node_modules`, named `children` or `/^on[A-Z]/` with a call signature | `onCopy` |
| 8 | everything else | inherited `nonce` |

Rank 3 sits above the wide ranks because a member with no declaration site cannot be shown to be
third-party, and it is exactly the shape a recipe/variant type produces.

**Named variant axes.** One shape defeats every structural signal: chakra declares `colorPalette` in
the *same* 705-member generated interface as its three hundred style props (`system.gen.ts`), with a
24-member union that mixes string literals and `string & {}`, so it is neither narrow, nor
declaration-less, nor variant-shaped. `KNOWN_VARIANT_AXIS_NAMES` promotes it to rank 1 (when
variant-shaped) or rank 2 (otherwise) regardless of the declaration site's width:

`colorPalette`, `colorScheme`, `variant`, `size`, `tone`, `intent`, `appearance`, `severity`,
`status`.

The list is closed and each entry is a name a component library reserves for an axis a user varies to
change how the component looks; none is a DOM attribute. The promotion additionally requires the prop
to carry a string-like type (a `string` or string-literal member), so a same-named callback or
numeric prop is unaffected.

An intersection that narrows a wide surface (`Omit<Wide, K>`) keeps the original declarations, so its
members stay at their own rank rather than becoming declaration-less: verified directly (a 45-member
own interface crossed with a 60-member `node_modules` surface through `Omit` still keeps 32 of 32 own
props).


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
`selectTargetCandidate` consults it over `scanExports`'s own list rather than over declaration order.

There are still **two** implementations of that order: `selectMeasuredExport` here and
`detectComponentExport` (`harness.ts`), each with its own `Provider` pattern. Lane B does not own
`harness.ts`, so the duplication stands and is pinned instead of assumed:
`own-props-outrank-inherited.test.ts` imports both and asserts they agree over a shared export list,
including the default, stem-match, `*Provider`-skip, only-`Provider` and explicit-target cases.
Collapsing them into one function is an interface request to Lane A, recorded in the run report.

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

### Unit

`pnpm vitest run test/unit/own-props-outrank-inherited.test.ts test/unit/prop-default-disclosure.test.ts`
— 21 + 7 passed. Fixture `fixtures/own-props-rank/`: `RecipeBadge.tsx` (chakra's factory shape, no
render function), `VariantBadge.tsx` (heroui's three-export shape, canonical export declared last),
`DefaultsButton.tsx` / `BodyDefaultsButton.tsx` / `LegacyDefaults.tsx` (the three default sources),
`NumberBounds.tsx` and `ItemCount.tsx` (curve-mode names). `test/unit/prop-cap-ranking.test.ts` is the
pre-existing M81/M86 pin and still passes unchanged.

### Real repositories

Run against a scratch build (`npx tsc --outDir …/dist-b`), because the shared `dist/` was pinned for a
corpus re-test.

**chakra `packages/react/src/components/badge/badge.tsx --explain-props`** (`logs/fix-b-chakra-badge-explain.log`,
exit 0). Before: 32 props, none of them Badge's. Now `variant` and `size` are in the window:

```
Props (32):
  htmlTranslate unstyled asChild htmlSize htmlWidth htmlHeight htmlContent css variant size recipe
  as base p clipPath filter marker mask container color translate transition width height content
  _hover _active _focus _focusWithin _focusVisible _disabled _visited
```

After the `KNOWN_VARIANT_AXIS_NAMES` bump, `colorPalette` is in the window too, beside
`colorScheme`, `appearance`, `variant` and `size`:

    Props (32):
      htmlTranslate unstyled asChild htmlSize htmlWidth htmlHeight htmlContent css appearance
      colorScheme colorPalette variant size recipe as base p clipPath filter marker mask container
      color translate transition width height content _hover _active _focus _focusWithin

Measured cause for why nothing structural could reach it: `colorPalette` is declared in
`styled-system/generated/system.gen.ts` inside a 705-member interface, as a 24-member union that is
not all-literal (string literals present, no bare `string` member), while `variant` and `size` sit in
a 2-member interface in `recipes.gen.ts`.

**heroui `packages/react/src/components/badge/badge.tsx --explain-props`**
(`logs/fix-b-heroui-badge-explain.log`, exit 0). Before: `binding: badge.tsx:33` (BadgeAnchor's) with
`children required` and `color unknown`. Now:

```
  binding:  src/components/badge/badge.tsx:67
  exports:  BadgeRoot, BadgeLabel, BadgeAnchor
Props (32):
  children     reactnode  optional  (no values)
  className    string     optional  "test"
  color        union      optional  "default", "accent", "danger", "success", +1
  placement    union      optional  "top-right", "bottom-left", "bottom-right", …
  size         union      optional  "md", "lg", "sm"
  variant      union      optional  "primary", "secondary", "soft"
```

Line 67 is `const BadgeRoot`; `children` is optional as `BadgeRootProps` declares it; all four
`tailwind-variants` props are unions with their values.

**base-ui `packages/react/src/number-field/root/NumberFieldRoot.tsx --explain-props`**
(`logs/fix-b-baseui-numberfield-explain.log`, exit 0). Before: `Mode: curve over "max"` over a DOM
node count that never moved. Now:

```
Curve mode:   would not activate: no array or numeric scaling prop
Matrix mode:  would not auto-activate
```

**dub `packages/ui/src/badge.tsx --matrix --samples 3 --max-combos 4 --explore-budget 20`**
(`logs/fix-b-dub-badge-matrix.log`, exit 0). The finding's own hypothesis ("axis selection skips
exactly the first 2 extracted props") is refuted; the measured cause was value count.
`variant union optional "default", "violet", "blue", "green", +8 more` is twelve values against an
`isMatrixEligible` window of 1..8. M103 fixed the extraction half and M104's I10 section fixed the
axis half (an over-wide union is an axis over a truncated value set). Now:

    Prop Matrix (variant x defaultChecked x suppressContentEditableWarning x suppressHydrationWarning x ...)
    4 cells measured, 4 hottest shown:
    Axes crossed: variant: 2 of 12 values crossed, defaultChecked, suppressContentEditableWarning.
    Result: PASS

JSON: `combos[].props.variant` is `["default", "violet", "default", "default"]` - Badge's only own
prop is now axis 0 and is crossed.

### A required prop nothing can be synthesized from (dub-F2, disclosure half)

dub's `packages/ui/src/table.tsx` declares `table: TableType<T>` - required and class-like, so
synthesis produces a placeholder object and the render dies on
`table.getVisibleLeafColumns is not a function` with nothing said in either mode.
`warnDegenerateProps` only covers the case where synthesis gave up outright.
`SYNTHESIZED_REQUIRED_OBJECT_WARNING` covers the case where it produced something the component
cannot use: emitted from `typeToSchema` for a required prop with `provenance: "placeholder"`, `kind`
`object`/`unknown` and no `degenerate` reason, naming the prop, `checker.typeToString(propType)` and
the `<stem>.props.tsx` remedy through `presetRemedyClause`. Because it is emitted during extraction,
`--explain-props` and the full run both print it. `isSynthesizedRequiredObjectWarning` is exported
for Lane C.

The discriminator is behaviour, not shape: the warning fires only when the type declares a member
that is a method or a function-typed property (`hasMethodMembers`). A plain domain object of data
fields synthesizes into something the component can use and stays silent
(`fixtures/m60/domain-object.tsx` is the regression pin).

Real: `cd /e/repositories/dub && node .../cli.js packages/ui/src/table/table.tsx --explain-props`
(`logs/fix-b-dub-table-explain.log`, exit 0), where nothing was said before:

    Warning: required prop "table" in ...\packages\ui\src\table\table.tsx is typed Table<T>, which
    no synthesized value can satisfy, so it is measured with a synthesized stand-in: the component
    receives an object with none of that type's methods. Add table.props.tsx next to it to supply
    typed values for measurement.

### Lint

`pnpm lint` (`tsc --noEmit`) clean.

Cleanup: `120fps-report.json` and `.120fps-harness-*` removed from dub; `git status --porcelain`
empty in chakra-ui, heroui, base-ui and dub.

### Lane C evidence (I8 rendering half, calcom-F2)

Extraction has carried `defaultValue` / `defaultSource` since I8; `--explain-props` printed no
`default` column, so the tool knew calcom Button's six defaults and said none of them.
`ExplainedProp` now carries both fields and `formatExplainProps` prints the column whenever any prop
declares a default, keyed on presence rather than truthiness so a `false` default is not dropped.

```
cd /e/repositories/calcom && node <scratch>/cli.js packages/ui/components/button/Button.tsx --explain-props
# EXIT=0
  prop                            type       required  default    value
  tooltipSide                     union      optional  "top"      "top", "right", "bottom", "left"
  tooltipOffset                   number     optional  4          1, 5, 20
  variant                         union      optional  "button"   "button", "icon", "fab"
  loading                         boolean    optional  false      true, false
  color                           union      optional  "primary"  "primary", "secondary", "minimal", "destructive"
  defaultChecked                  boolean    optional             true, false
```

The last row is a prop with no declared default: the cell is blank, never `undefined`. Tests:
`test/unit/prop-default-column.test.ts` (5), which goes through `explainProps` rather than
`extractProps`, the gap the earlier disclosure test left open.

