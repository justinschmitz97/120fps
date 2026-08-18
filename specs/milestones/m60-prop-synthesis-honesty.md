---
kind: milestone
status: implemented
tests:
  - test/unit/m60-prop-synthesis.test.ts
  - test/unit/m60-prop-synthesis-harden.test.ts
---

# M60 — prop synthesis honesty

## Purpose

M58 bound extraction to the right component. What that component's props are
*worth measuring with* was still decided by a classifier that gave up silently.
Six shapes degraded without a word, and the report presented the degraded run as
a measurement of the real component:

- `VariantProps<typeof buttonVariants>` — the shadcn/cva pattern — classified as
  `kind:"unknown"` with an empty value pool, so `variant` was never varied.
- An empty pool on an optional prop produced `[undefined, undefined]`, which
  cartesian-doubled every combo; half the combo budget measured byte-identical
  rows presented as distinct.
- Tuples, nested domain objects, `Map`/`Set` and class instances all collapsed
  to `{}`, which crashes the render the tool then reports timings for.
- A props type computed from a primitive (`React.ComponentProps<typeof X>`)
  whose members are declared inside `node_modules` produced an empty schema and
  the generic "no props extracted" line, with no attempt at resolution.

## Contract

### Value pools

- A prop whose type is a literal union after stripping `undefined`, `null` and
  `void` MUST classify as `union` with those literals as its values. This is
  what makes `VariantProps<typeof x>` — a homomorphic mapped type over the cva
  config's `variants` object — enumerable, and it MUST work through
  `Omit`/`NonNullable`/`Parameters` without syntactic inspection of the `cva`
  call.
- A prop's value pool MUST NOT contain the same value twice. `undefined` is
  appended for an optional prop only when the pool does not already carry it.
- `generateCombinations` MUST NOT return two combinations with equal values for
  every prop. De-duplication happens before any cap, so the count after it is
  ≤ the count before and `--max-combos` semantics are unchanged.

### Shapes

- A tuple MUST produce a fixed-arity array with one value per position, typed
  per position (`[string, string]` → two real strings). A tuple stays
  `kind:"object"`: its arity is part of its type, so it is never a scaling
  candidate and `detectScalingProps` MUST NOT match it.
- An object prop MUST produce a shaped value: properties recursed one level at a
  time to a depth cap, with primitive, literal, enum, array and nested-object
  leaves. Recursion MUST be cycle-safe (a type already on the current path is
  not re-entered) and property-capped.
- An intersection (`Omit<Base, "x"> & { y: string }`) MUST be shaped like the
  object it is; a union of object types stands in for its first member, keeping
  the discriminant literal.
- A prop whose value contains an untransportable member MUST be marked
  degenerate even when the rest of it synthesized — a component reading
  `wrapped.index.get(k)` fails on the entry array just as it would on `{}`.
- `Date` and `RegExp` MUST produce real instances — Playwright's evaluate
  serializer carries both.
- `Map`, `Set`, `WeakMap`, `WeakSet`, `ReadonlyMap` and `ReadonlySet` MUST NOT
  be reported as `{}`. The same serializer has no case for them, so a real
  instance cannot reach the page; the prop carries its entries as an array
  (`[[key, value], …]` for maps, `[value, …]` for sets) so the JSON props dump
  shows what was passed, and the prop is marked degenerate.
- Where no faithful value exists — a class instance, a `Promise`, a type with no
  synthesizable members, an empty pool on a required prop — the prop keeps its
  degraded value and MUST be named in a degenerate-prop warning that points at
  `<stem>.props.tsx` (M44). An empty pool on an *optional* prop is not degraded:
  measuring the prop absent is a legitimate answer.
- The warning MUST NOT fire when `<stem>.props.tsx` already exists, and
  `applyPropPresets` MUST clear the mark on every prop it replaces: a preset is
  the thing the warning asks for.

### Foreign and computed props types

- A property MUST NOT be dropped merely because it is declared inside
  `node_modules`. It is dropped when every declaration sits in a TypeScript
  default library or in React's own type package (`@types/react`, `react`) —
  which is where the ~300 DOM/ARIA members come from — or when its name is an
  `aria-`/`data-` attribute.
- Locally declared properties come first, then foreign ones, and the list is
  capped at 32. A cap that truncates MUST say so on stderr.
- When the target's first parameter has a *computed* type annotation (a type
  reference with type arguments, or an intersection containing one) and no props
  can be enumerated from it, extraction MUST warn naming that annotation, rather
  than returning `[]` silently.

### Invariants

- Extraction never throws on an exotic type; every unsupported shape degrades to
  a value plus a warning.
- Generated values stay transportable: JSON-representable, plus `Date`/`RegExp`.
  Every clone path preserves them — `fillArray`'s element clone included, where
  walking a `Date`'s entries would produce `{}`.
- Vue `defineProps` extraction, M58 target binding, auto-scaling detection and
  `extractAllProps` keep their results.
- Warnings are emitted once per file per process and cleared by
  `resetExtractionCache`.

## Design

### Classification

`classifyType` strips `null` and `void` next to `undefined` before deciding.
That single change makes the whole cva family enumerable: `VariantProps` resolves
to `keyof V[Variant] | null | undefined` per variant, so the surviving members
are exactly the variant keys. Nothing inspects the `cva` call — the checker has
already done the work, and the same change fixes every other
`literal-union | null` prop.

Shape handling is ordered most-specific first, because the generic object branch
would otherwise claim all of them: tuple (`checker.isTupleType`), then the
well-known constructors (`Date`, `RegExp`, `Map`, `Set`, `Promise`), then class
instances, then plain objects.

### Synthesis

`synthesizeValue` gained the guards it needs to run against a *props-level*
type rather than only an array element: a stack of the types on the current path
(cycle safety), a per-object property cap, and the same noise filter the
top-level schema uses so a nested `HTMLAttributes` does not become 24 junk keys.
`{}` is never returned as a "shaped" value — an object type that yields no
usable member is degenerate and says so.

### Transport

Verified against `playwright-core` 1.59
(`lib/utils/isomorphic/utilityScriptSerializers.js`): the evaluate serializer
carries `undefined`, `null`, `NaN`, `±Infinity`, `-0`, `Date`, `URL`, `RegExp`,
`BigInt`, `Error`, arrays, plain objects and typed arrays. A `Map` reaches the
page as `{}`. Rather than inventing a second revival channel next to M44's
preset refs, a collection prop degrades loudly and travels as its entries, so
the report shows the entries instead of an empty object that reads like a
successful synthesis.

### Warnings

Two, both on stderr, both deduped per file for the process:

- degenerate props — one line naming each prop and why, ending in the
  `<stem>.props.tsx` escape hatch;
- an unenumerable computed props type — names the annotation text and the
  target component.

## Hardening

| # | Hypothesis | Result |
|---|---|---|
| H1 | A self-referential prop type recurses forever | Pass — the path stack stops the first repeat |
| H2 | A union of object shapes degrades to unknown | Pass — first member, discriminant kept |
| H3 | Optional nesting stops synthesis early | Pass — filled to the depth cap |
| H4 | Shaped objects break M30 element templates | Pass — readonly arrays unchanged |
| H5-H6 | `Date`/`RegExp`, nested or not, become field bags | Pass — real instances |
| H7 | A nested `Map` hides inside a synthesized parent | Pass — parent marked degenerate |
| H8 | `Record<string, T>` claims a shape it has none of | Pass — `{}` plus a reason |
| H9 | An empty or rest tuple throws | Pass — filled, arity capped at 8 |
| H10 | Shaped objects shadow the scaling candidates | Pass — arrays still matched, tuples not |
| H13-H14 | cva compound and boolean variants break the axes | Pass — unions and booleans |
| H15-H16 | Every empty pool warns, including legitimate ones | Pass — required only |
| H17 | A DOM-wide props type floods the schema | Pass — capped at 32, disclosed |
| H18-H19 | The warning nags a user who already wrote presets | Pass — suppressed and cleared |
| H25 | An intersection prop type degrades to unknown | **Fixed** — Intersection is object-like |
| H26 | A defaulted generic parameter resolves to nothing | Pass — element shape |
| H28 | Cloning an array element flattens a `Date` to `{}` | **Fixed** — `cloneTemplate` keeps instants |
| H29 | An array of `Map`s produces `{}` elements | Pass — entry arrays |
| H30-H31 | Readonly tuples and `T \| null` regress | Pass |
| H33 | The cap spends itself on inherited members | Pass — local first |
| H34 | `ComponentProps<"button">` returns `[]` silently | Pass — warns naming the annotation |

## Notes

- A tuple's `kind` stays `"object"` rather than gaining a `"tuple"` kind: the
  only thing downstream reads is the value pool, and a new kind would have to be
  taught to every switch for no behavioural gain.
- `kind:"unknown"` with an empty pool on a required prop is reported as
  degenerate. It means the prop is passed as `undefined`, which is the crash the
  dogfood run kept mistaking for a fast render.
- The degenerate mark lives on `PropSchema`, not in the report: it exists to
  drive the warning and to be cleared by presets. Nothing in the JSON output
  changed shape; what changed is the values inside `combos[].props`.
