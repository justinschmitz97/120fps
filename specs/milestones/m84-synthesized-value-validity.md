---
kind: milestone
status: draft
tests:
  - test/unit/prop-synthesis-depth-independence.test.ts
  - test/unit/prop-synthesis-image-src.test.ts
  - test/unit/prop-synthesis-identity-collection.test.ts
  - test/unit/prop-synthesis-mixed-union.test.ts
  - test/unit/prop-provenance.test.ts
---

# M84: Synthesized prop values are semantically valid

## Purpose

`--explain-props` and the run share one synthesis path, but a handful of its branches choose a
value using only the type, when the prop's name or position carries a stronger, already-available
signal. Three shapes reach the browser wrong: a name-based heuristic that works at the top level of
a props object silently stops applying one level down inside a nested object; a `string`-typed image
source synthesizes a bare placeholder that 404s against the harness's own origin; an array whose
element type cannot be resolved (an unbound generic) synthesizes primitive elements for a prop a
component keys by object identity. A fourth gap is not a wrong value but a dropped one: a union
mixing a primitive type with a literal member, or mixing structurally different branches, has no
classification branch and falls through to an empty, undisclosed `"unknown"` schema.

## Contract

### MUST

- A name-based value heuristic that applies to a top-level prop applies identically at every depth of
  a nested object or array element. commerce's control proves the gap: `currencyCode` at top level
  synthesizes `"USD"`, and `label.currencyCode` one level down synthesizes `"text"`.
- A prop whose type or name identifies it as an image source (`src`, `srcSet`, `poster`) synthesizes a
  value that resolves without a network request — an inline `data:` URI. `"test"` is not acceptable: it
  relative-resolves against the harness origin and 404s.
- A prop feeding an identity-keyed collection (an array of objects consumed as rows or items)
  synthesizes stable object identities across renders within a combo, so a component keying a
  `WeakMap` on its own rows does not throw. element-plus's `data:["item"]` produced
  `TypeError: Invalid value used as weak map key`.
- A mixed primitive-and-literal union (`boolean | 'trap-focus'`, `number | 'any'`) synthesizes a
  member of that union.
- A multi-branch union (`string | ReactElement`, `(() => ReactNode) | ReactNode | null`) reports every
  branch it collapsed, and which branch it chose.
- Every synthesized value carries `provenance` per the cross-lane interface above.

### MUST NOT

- Silently drop a prop from synthesis. base-ui's `modal` and `step` were dropped with zero warning,
  sitting next to correctly-flagged degenerate props.
- Emit a value whose only justification is that it type-checks, when the prop's name or type carries a
  stronger signal that is already available.

### Invariants

- `classifyType`'s top-level string branch and `synthesizeValue`'s nested string branch resolve a
  given name through the same function: there is exactly one place a name-based string heuristic is
  defined, never two copies that can drift.
- A schema's `provenance` is always one of `"declared" | "preset" | "heuristic" | "placeholder" |
  "contract"`, never absent for a schema whose value the run actually measures. `"preset"` is set only
  by `applyPropPresets`; `prop-gen.ts` itself never assigns it.

## Design

**Depth-independent naming heuristics** (`src/prop-gen.ts`). `namedStringValue(name)` is the single
function both `classifyType` (top-level, `MAX_PROPS`-capped props) and `synthesizeValue` (nested
object members, any depth) call for a `string`-flagged type. `synthesizeValue` did not previously
receive the property name it was synthesizing a value for; it now does, threaded from the object
property loop (`record[prop.name] = synthesizeValue(..., prop.name)`) and left `undefined` at every
call site with no name of its own (array elements, tuple positions, Map/Set entries), where the
generic `"text"` fallback is correct because there is no name to test. `namedStringValue` covers
three conventions: `currency`/`currencyCode` → `"USD"`, `locale`/`language` → `"en-US"`,
`src`/`srcSet`/`poster` → an inline 1x1 transparent GIF `data:` URI (`DATA_URI_PLACEHOLDER`). Each
match is deliberately an exact, case-insensitive name match, not a substring or prefix test: the
existing philosophy (M81 3d) is a narrow allowlist closing a repeatedly-observed failure class, not a
general claim that every string is now safe.

**Identity-keyed arrays** (`src/prop-gen.ts`, `classifyType`'s array branch). When `synthesizeElement`
cannot resolve the element type (commonly an unbound generic parameter, `T[]`) and the prop's name
matches `IDENTITY_COLLECTION_NAME` — the same `items`/`data`/`entries`/`records`/`elements`/`list`/
`options` vocabulary `detectScalingProps` already uses, plus `rows` — the fallback element is a shaped
object (`{ id: 1 }`), not the bare string `"item"`. This is a dedicated pattern, not a reuse of
`ITEMS_PATTERN` itself, so it can never change `detectScalingProps`'s existing reason text or sort
priority for an already-resolvable array prop. This is set as the schema's own `elementTemplate`, so `fillArray`
(`src/prop-gen-values.ts`) — used for scale-mode arrays — inherits it automatically without any
name-awareness of its own: `fillArray` stays a mechanical clone-or-generic-string function, and the
one place that decides "should this collection's items be objects" is `prop-gen.ts`. A prop whose
name does not match the collection pattern is unaffected: its unresolved-element array still falls
back to the generic string, exactly as before, because there is no signal it holds identity-sensitive
rows.

**Mixed and multi-branch unions** (`src/prop-gen.ts`, `classifyType`). After the existing pure-kind
checks (boolean union, string-literal union, number-literal union, reactnode, element-or-callable
union, function, object) all fail to match, a union with more than one non-`undefined` member no
longer falls to `kind: "unknown"` with an empty value. It picks the first member with a synthesizable
primitive kind — string/number literal preferred over a bare `boolean`/`string`/`number`, since a
literal is the more informative sample — and classifies using that member's kind
(`base-ui`'s `modal?: boolean | 'trap-focus'` classifies as `boolean`; `step?: number | 'any'`
classifies as `number`). Separately, `typeToSchema`'s per-prop loop checks every classified prop's raw
type for a genuine multi-branch shape (more than one non-`undefined` member, not a pure literal union,
not a boolean union, not a plain `ReactNode`, not an element-or-callable union — those are already
either fully enumerated or already disclosed via M81's `degenerate` warning) and, when it finds one,
emits a warning naming every branch's printed type and which kind the schema was classified as. This
is the same `sink`/stderr channel every other extraction warning uses, so it survives into
`--explain-props` and the full run identically, with no new rendering code needed in another lane's
file.

**Provenance** (`src/prop-gen.ts`, cross-lane, consumed by M85). `PropProvenance` — `"declared" |
"preset" | "heuristic" | "placeholder" | "contract"` — is exported next to `PropSchema`, which gains
an optional `provenance` field. Assignment:
- `"declared"`: the value came directly from the type's own structure — a literal union member,
  boolean, tuple position, a fully-resolved array/object built from real declared sub-fields, a
  Map/Set/Iterable's real declared key/value types, `Date`/`RegExp` instances.
- `"heuristic"`: a name-based special case chose the value — `namedStringValue`'s three conventions,
  and the identity-collection object fallback.
- `"placeholder"`: a generic, type-agnostic fill with no signal from name or declared structure — the
  bare `"test"` string, generic numbers, the reactnode placeholder, the no-op function, an empty or
  fully-opaque object, the non-identity `"item"` array fallback, an `"unknown"`-kind degenerate value.
- `"contract"`: a boolean prop named exactly `asChild`, `as`, or `render` — the three names this
  convention uses across every corpus repository observed (Radix, Base UI, react-aria, shadcn). A
  general structural detector for "any boolean whose true branch changes what another prop must be"
  needs cross-prop analysis this milestone does not attempt; the named allowlist is the same
  deliberately-narrow shape as the string-heuristic allowlist above.
- `"preset"` is never assigned here. `applyPropPresets` (`src/prop-presets.ts`) sets it on every
  schema whose value pool it replaces, overwriting whatever `prop-gen.ts` assigned — a preset always
  wins the provenance question, matching it already winning the value question.

An object schema built by `synthesizeValue`'s recursive walk (`objectSchema`'s shaped-object branch)
takes the riskiest provenance among its own synthesized descendants: `"heuristic"` if any nested
field used a naming convention, else `"placeholder"` if any nested field used a generic fallback, else
`"declared"`. `SynthContext` gains two booleans (`usedHeuristic`, `usedPlaceholder`) set at the same
points `synth.notes` already records a degenerate reason, so a consumer deciding whether a crash
traces to a harness-supplied value (M85) can read one field on the outer prop rather than walking the
synthesized object itself.

## Open questions

None.

## Verification

Fixtures under `fixtures/m84/`, asserted with `extractProps`/`extractPropsDetailed`:

- Nested `currencyCode`: a `label: { currencyCode: string }`-shaped prop, one level down, synthesizes
  `"USD"`, matching the top-level control.
- An image `src`: a `poster: string` prop synthesizes a `data:` URI, not `"test"`.
- An identity-keyed row array: an unresolved generic element type on a `data`/`items`-named prop
  synthesizes an object element, and `new WeakMap().set(value[0], 1)` does not throw.
- A mixed union: `boolean | 'trap-focus'` and `number | 'any'` each synthesize a real member, and the
  cap-warning-style stderr channel names both collapsed branches.
- A three-branch union (`string | ReactElement | (() => void)`-shaped): the warning names all three
  branches and which one was chosen.
- Every fixture above asserts `schema.provenance` alongside the value.
