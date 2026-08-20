---
kind: milestone
status: draft
tests:
  - test/unit/prop-cap-ranking.test.ts
  - test/unit/prop-inheritance-disclosure.test.ts
  - test/unit/prop-synthesis-safety.test.ts
  - test/unit/explain-props-run-parity.test.ts
  - test/unit/prop-target-binding-forwardref.test.ts
  - test/unit/recursive-generic-prop-bound.test.ts
---

# M81: prop schemas are complete and safe to render

Closes: heroui-F1, heroui-F2, chakra-ui-F6, ant-design-F3, commerce-F1, base-ui-F2, base-ui-F3,
base-ui-F4, element-plus-F1, and the conflict between radix-primitives-F3 and excalidraw-F4
(section 5 — resolved as a stated conditional, not asserted as a uniform fix).

## Goal

The schema contains the props that define the component, and every synthesized value is safe to
render or is marked degenerate before the run, not during it. Today the 32-prop cap keeps whatever
props sort first by an accident of declaration site, a whole class of inherited members vanishes
with zero disclosure, `--explain-props` and the actual run can disagree about the same schema
decision, and a handful of degenerate/generic-recursive shapes crash the harness instead of
degrading honestly.

Four independent mechanisms in `src/prop-gen.ts` and `src/prop-gen-values.ts` produce this, traced
directly against the current source (not against `FIELD-TEST.md`'s line numbers):

1. **Cap ordering** (`src/prop-gen.ts:1007-1016`): `declaredHere` sorts a prop to the tail whenever
   `prop.getDeclarations()` is empty. A property symbol synthesized from a mapped/computed type
   (`VariantProps<typeof x>` reached via `interface X extends ...Variants {}`) has *no* declaration
   node at all — not a third-party one, none — so `[].some(isLocalDeclaration)` is `false` and it
   sorts last, guaranteed to lose to `MAX_PROPS = 32` (`:976`) against every prop with any
   declaration, however irrelevant.
2. **Pre-cap noise filtering** (`src/prop-gen.ts:966-996`): `isNoiseProp` removes a prop from `kept`
   *before* `ordered`/`MAX_PROPS` ever see it, whenever every one of its declarations lives in a
   default-lib `.d.ts` or matches `REACT_TYPE_PACKAGE` (`node_modules/(@types/)?react(-dom)?/`).
   The comment at `:966-968` frames this as filtering "the ~300 DOM/ARIA members every
   `ComponentProps` drags in," but the regex is declaration-site-based, not member-name-based: it
   removes `onClick`, `disabled`, and `children` exactly as readily as `aria-activedescendant`,
   because all of them are declared inside `@types/react`. Because the removal happens before
   `ordered.length > MAX_PROPS` is computed (`:1011`), the count used to decide whether
   `warnPropCap` fires is already short by however many members this step erased — so a component
   whose true surface exceeds 32 can report a total *under* 32 and never warn at all.
3. **Unconditional value resolution** (`src/prop-gen-values.ts:126-147, 214-247`): `resolveAnchorValue`
   and `resolveBaseValues` both switch on `schema.kind` and return a value — `REACT_PLACEHOLDER`
   for `"reactnode"`, `schema.values[0] ?? {}` for `"object"` — with no check of `schema.degenerate`.
   `applyPropPresets` (`src/prop-presets.ts:173-`) strips `degenerate` only when a preset supplies a
   real value; absent a preset, the flag survives on the schema all the way to these two functions,
   which ignore it. `--explain-props` and the run call the *same* `typeToSchema` /
   `warnDegenerateProps` path (`src/prop-gen.ts:252-268`, `:432`) to produce and warn about the
   schema, so the dry run's diagnosis is not stale or separately computed — the gap is entirely in
   these two downstream value-resolution functions never reading the flag the schema already
   carries.
4. **`ReactNode` classification is wider than what's safe to placeholder** (`src/prop-gen.ts:1049-1052`,
   `isReactNodeType` at `:1443-1446`): a union is classified `"reactnode"` if *any* non-undefined
   member's `typeToString` matches `/ReactNode|ReactElement|JSX\.Element/`. Base UI's
   `render?: React.ReactElement | ComponentRenderFn<...>` matches on its `ReactElement` member, so
   it gets the same treatment as a plain `children?: ReactNode` — a placeholder *string*. A plain
   `ReactNode` renders a string fine; `ReactElement | Function` does not, because the library calls
   `React.isValidElement(render)` on it.

## Scope

### 1. Rank props before capping them (`src/prop-gen.ts:998-1027`)

Replace the two-bucket `declaredHere` partition (`:1007-1009`) with a three-tier rank, computed
over `kept` before slicing to `MAX_PROPS`, stable within each tier:

- **Tier 1 — variant surface.** A prop whose own (non-`undefined`/`null`) type is a finite literal
  union (string or number literals — the same shape `classifyType` later calls `kind: "union"`,
  `:1067-1093`) or plain boolean (`:1059-1065`). This check reuses the existing cheap type-flag
  tests already in the file (`isBooleanUnion`, `:1436-1441`, and the literal-union predicates
  inline in `classifyType`) against `checker.getTypeOfSymbolAtLocation(prop, decl)` — no recursive
  synthesis, so it is affordable to run over all of `kept` (up to ~850 props on chakra-ui) before
  the cap, not just the 32 survivors.
- **Tier 2 — locally meaningful.** A prop `declaredHere` today (declared outside `node_modules`,
  `isLocalDeclaration` at `:987-989`) **or** with zero declarations at all. Zero declarations means
  a computed/mapped-type member — it cannot be "third-party," because there is no declaration site
  to be third-party at. This is the direct fix for heroui-F1: `variant`/`size`/`fullWidth`/
  `isIconOnly` (zero declarations, from `ButtonVariants` via `extends`) move from "sorts after
  every real declaration" to Tier 1 or 2, ahead of react-aria-components' ~100 declared-in-
  `node_modules` passthrough props.
- **Tier 3 — everything else** (declared exclusively in `node_modules`, not variant-shaped):
  unchanged today's tail behavior.

`MAX_PROPS` (`:976`) and `warnPropCap` (`:777-783`) are unchanged; only what feeds `ordered`
changes. Table.tsx's positive control (`variant?: TableVariants["variant"]`, indexed-access,
locally re-declared — already `declaredHere: true` today) is unaffected: it was already Tier 2 and
stays there.

### 2. Fold noise filtering into the same rank instead of a silent pre-cap removal (`src/prop-gen.ts:966-996`)

`isNoiseProp`'s two branches are no longer treated identically:

- `NOISE_PROP_NAME` (`aria-`/`data-` prefix, `:972`) stays a hard, silent pre-cap filter. No field-test
  finding names a missing `aria-*`/`data-*` prop as a defect; these are decorative and this
  milestone does not change their handling.
- The `isAmbientNoiseDeclaration` branch (declared only in a default-lib file or `REACT_TYPE_PACKAGE`,
  `:982-985`) stops being a pre-cap `filter`. Its members re-enter `kept`/`ordered` and are ranked
  like anything else, with one addition to the Tier 1/2 test above: a prop named `/^on[A-Z]/` whose
  type carries a call signature (an event handler — `onClick`, `onChange`, `onFocus`, ...), or named
  exactly `children`, is Tier 2 regardless of declaration site. This is the direct fix for
  ant-design-F3: `onClick` (event-handler-named, reached through
  `Omit<React.HTMLAttributes<...> & React.ButtonHTMLAttributes<...> & React.AnchorHTMLAttributes<...>, K>`)
  and `TagProps.children` (via `extends React.HTMLAttributes<HTMLSpanElement>`) both move out of the
  tier that a large-enough DOM surface pushes past the cap, and into the tier that survives it.

Because these members now flow through `ordered`, `ordered.length` includes them, so
`warnPropCap` (`:777-783`, unchanged wording) fires honestly whenever the true total — including
what used to be silently dropped — exceeds 32. A component whose inherited surface pushes it over
the cap gets the same "N props were extracted ... measuring the first 32" disclosure Select and
Modal already get (`ant-design-F3` vs. the honest contrast in `ant-design-F7`); a component whose
surface stays under 32 gets every member, including the ones this milestone stops erasing.

### 3. Synthesized values must be safe to render (`src/prop-gen.ts`, `src/prop-gen-values.ts`)

Three independent changes, closing heroui-F2, base-ui-F2, base-ui-F3, commerce-F1:

**a. Known-shape synthesis for structural iterables.** `collectionValue` (`:1260-1281`) only
matches `builtinName(type)` against `MAP_TYPES`/`SET_TYPES` (`:1240-1241`); anything else with a
default-lib-declared name — including `Iterable<T>` — falls to `opaqueReason`'s generic branch
(`:1329-1332`) and gets `values: [{}]` via `objectSchema` (`:1188-1191`), which is not a member of
`Iterable<T>` and throws inside `new Set(prop)`/`new Set({})`. Add a third branch to
`collectionValue` (or a sibling function) recognizing `Iterable<T>`/`ReadonlyArray`-shaped
structural iterables (a default-lib name, or a type with a `[Symbol.iterator]` call signature) and
returning a real array — `[]`, or `distinctValues`-style entries when the element type is
synthesizable (`:1285-1294`, already shared with Map/Set) — which *is* a valid `Iterable<T>` and
does not throw. This is a real, exercised value, not merely an omission: it satisfies the
milestone's "known-shape synthesis," not just "don't crash."

**b. `ReactElement | Function` is not `ReactNode`.** `classifyType`'s reactnode branch
(`:1049-1052`) must not classify a union as `"reactnode"` on the strength of one member matching
`/ReactElement|JSX\.Element/` when the union's *other* non-undefined members are function
signatures and none of its members is the broader `ReactNode` itself (which structurally includes
`string | number`, safe to placeholder) or a plain primitive. Concretely: keep `"reactnode"` only
when a member's `typeToString` is exactly `ReactNode` (or the type is provably assignable from
`string`, which `ReactNode` is and `ReactElement` is not); a `ReactElement | (props) => ReactElement`
shape — Base UI's `render`, and the same "universal customization prop" idiom in any headless
library — instead falls through to `objectSchema`'s existing opaque path (a function/element union
has no synthesizable field-bag shape), which already marks it degenerate via `opaqueReason`
(extend `opaqueReason`, `:1323-1334`, with a branch for "union of ReactElement and callable, no
primitive member" returning `"<type> requires a real element or render function"`).

**c. Degenerate schemas must not reach the browser as `{}`/placeholder.** `resolveAnchorValue`
(`src/prop-gen-values.ts:126-147`) and `resolveBaseValues` (`:227-247`) gate their `"object"` and
`"reactnode"` branches on `schema.degenerate`: when set, return `undefined` (an omitted prop, not
a fabricated stand-in) instead of `schema.values[0] ?? {}` / `REACT_PLACEHOLDER`. `"unknown"`
already returns `undefined` unconditionally (`:144-145` / `:245-246`) and needs no change — this is
why commerce's `src: string | StaticImport` (classified `"unknown"`) already degrades safely while
heroui's `Iterable` and base-ui's `render` (both classified `"object"`/`"reactnode"`) do not. A
preset in `<stem>.props.tsx` still overrides this exactly as today (`applyPropPresets` clears
`degenerate` when it supplies a value, `src/prop-presets.ts:173-`); this milestone extends the M60
degenerate vocabulary and M44 escape hatch, it does not add a second one.

**d. Named runtime-validated string conventions.** A `string`-typed prop is not degenerate by
`classifyType`'s test (`:1096-1098`, any string satisfies `string`), so 3a-3c cannot catch
commerce-F1: `currencyCode: string` synthesizes the generic placeholder `"test"`
(`:1097`/`resolveBaseValues` `"string"` branch), which is a member of `string` but not of
`Intl.NumberFormat`'s accepted currency codes, and crashes. This is not a synthesis failure the
type system can see, so it is handled the same way the codebase already handles the analogous
"name implies shape" case for scaling props (`src/prop-gen.ts:~197-203`, "numeric prop name matches
scaling pattern"): a short, named allowlist of prop-name conventions matched against a plain
`string`-kind schema before falling back to `"test"` — `currencyCode`/`currency` → a real ISO 4217
code (`"USD"`), `locale`/`language` → a real BCP 47 tag (`"en-US"`). This is deliberately narrow: it
closes the one repeatedly-observed false-FAIL class (`Intl` construction), not a general claim that
every runtime-validated string is now safe. A `string` prop outside this allowlist that a component
validates at runtime and rejects still fails via the existing, correct M59 render-health path
(`FAIL [render error]`, page errors captured) — that is a real, honestly-reported result, not a gap
this milestone closes.

### 4. `--explain-props` must consume the same schema decision as the run (`src/prop-gen-values.ts`)

Section 3c *is* the fix: because `resolveAnchorValue`/`resolveBaseValues` are the only place the
run's actual prop values are produced, and both now read `schema.degenerate` — the same flag
`--explain-props` already prints (`src/analyze.ts:1757`) — the dry run and the run can no longer
disagree about a prop this milestone covers. `typeToSchema`/`warnDegenerateProps` were already
shared between the two paths (`src/prop-gen.ts:252-268`); this milestone closes the only place they
diverged. base-ui-F4 (Button's schema drops `disabled`) is closed by section 2, not a separate mechanism:
per `findings/base-ui.md` (the base-ui checkout is not present in this workspace, so this line
citation is the finding's own, not independently re-read here), `disabled` is declared in
`@types/react`'s `ButtonHTMLAttributes`, reached via `BaseUIComponentProps<'button', ...>` extending
`React.ComponentPropsWithRef<'button'>` (`internals/types.ts:36-42` per the finding) — the same
pre-cap-noise-filter mechanism as ant-design's `onClick`, which *is* independently confirmed against
`src/prop-gen.ts`'s `REACT_TYPE_PACKAGE` regex (`:970`) matching any `@types/react` declaration
regardless of member name. Closed the same way: Tier 2 promotion is by name pattern for handlers; a
plain boolean like `disabled` is separately covered because Tier 1 already promotes boolean/union
props ahead of Tier 3 regardless of declaration site.

### 5. forwardRef declaration shape (`src/prop-gen.ts:620-694, 858-875, 930-946`)

Both `radix-primitives-F3` (accurate) and `excalidraw-F4` (confidently wrong) are forwardRef
components; the repository is not the variable. Read against the actual source in both field-test
checkouts:

- `radix-primitives/packages/react/select/src/select.tsx:312-314`:
  ```ts
  const SelectTrigger = React.forwardRef<SelectTriggerElement, SelectTriggerProps>(
    function SelectTrigger(props: ScopedProps<SelectTriggerProps>, forwardedRef) { ... }
  );
  ```
  The callback's first parameter carries an **explicit inline type annotation**
  (`props: ScopedProps<SelectTriggerProps>`).
- `excalidraw/packages/excalidraw/components/FilledButton.tsx:39-55`:
  ```ts
  export const FilledButton = forwardRef<HTMLButtonElement, FilledButtonProps>(
    ({ children, icon, onClick, label, variant = "filled", ... }, ref) => { ... }
  );
  ```
  The callback's first parameter is a **destructuring pattern with no type annotation**; its type
  is available only via contextual typing flowing from `forwardRef`'s own generic type arguments.

Traced against `src/prop-gen.ts`: `extractFunctionFromInitializer` (`:930-946`) unwraps
`forwardRef<...>(callback)` identically for both shapes — it takes `node.arguments[0]`, and a
call's *type arguments* (`<Elem, Props>`) are not part of `.arguments`, so both the named-function
and the arrow-function callback are reached the same way regardless of form. The divergence, if any,
is downstream in `propsFromParameter` (`:620-628`): `checker.getTypeAtLocation(param)` is called on
`fn.parameters[0]`. For the annotated case, TypeScript resolves the annotation directly. For the
unannotated destructured case, the checker must have already bound the contextual type from
`forwardRef`'s call-signature resolution to answer `getTypeAtLocation` correctly — and whether an
ad hoc `getTypeAtLocation` call (outside a full-program `getDiagnostics()` pass) reliably triggers
that binding for an argument to a generic call is a property of the TypeScript compiler API, not of
120fps's own code, and is **not yet confirmed** by reading source alone.

**This milestone requires both shapes as fixtures and states the conditional, not a conclusion:**

- Fixture A: `forwardRef<Elem, Props>(function Name(props: Props, ref) { ... })` — explicit
  parameter annotation. Radix's four corroborating components (`SelectItem`, `SelectTrigger`,
  `TabsTrigger`, plus `select.tsx#SelectItem`) are all this shape.
- Fixture B: `forwardRef<Elem, Props>(({ a, b, c }, ref) => { ... })` — destructured parameter, no
  annotation, type available only contextually. `FilledButton` is this shape.
- A third fixture, **not required by the two named repos but necessary to isolate the true
  variable**: `forwardRef<Elem, Props>(function Name({ a, b, c }, ref) { ... })` — named function
  expression, destructured, unannotated. Because `extractFunctionFromInitializer` and
  `propsFromParameter` treat arrow and named-function-expression forms identically (confirmed by
  reading `:930-946`, `:620-628` — both branch only on `ts.isArrowFunction || ts.isFunctionExpression`,
  never distinguishing between them afterward), function form itself is not expected to matter; if
  Fixture C (function-expression, unannotated) fails the same way Fixture B does, that confirms
  annotation-presence — not arrow-vs-named-function-expression syntax — is the discriminator. If
  Fixture C passes while B fails, the earlier hypothesis is wrong and the real variable is
  elsewhere (candidate collection, `collectComponentCandidates`, or contextual-typing behavior
  specific to arrow functions) and must be re-derived from that result, not patched around.

Radix's `SelectTrigger`/`SelectItem`/`TabsTrigger` continuing to extract correctly is itself an
acceptance criterion of this section: a fix for Fixture B must not regress Fixture A.

### 6. Recursion bounding on generic/recursive types (`src/prop-gen.ts:998-1027, 1345-1434`)

`synthesizeValue` (`:1345-1434`) already bounds *value* synthesis two ways: a depth cap
(`depth >= synth.maxDepth`, `:1351`, `PROP_SYNTH_MAX_DEPTH = 4` for a top-level prop, `:1225`,
`1193`) and a same-`ts.Type`-identity stack guard (`synth.stack.includes(type)`, `:1408`). Neither
bounds *type classification* — the loop in `typeToSchema` (`:1016`) that calls
`checker.getTypeOfSymbolAtLocation(prop, decl)` (`:1018-1020`) for each of the (up to 32) kept
props, and `classifyType` itself (`checker.typeToString`, `type.getCallSignatures()`,
`type.getProperties()` at various points in `:1029-1214`), has no recursion guard at all — these
call the TypeScript checker directly on a raw `ts.Type`, and a self-referential *generic* type
(Element Plus's `table.vue`: `defineProps<TableProps<T>>()`, `TableProps<T>` pulling in
`TableColumnCtx<T>` which nests `children?: TableColumnCtx<T>[]`) can make a *single* checker call
(`typeToString`, property enumeration, or symbol-type resolution on one generic member) recurse
arbitrarily deep inside TypeScript's own instantiation machinery — a depth cap on 120fps's *own*
call stack does nothing to bound recursion happening inside one TS API call. This is why the crash
in element-plus-F1 lands immediately after the cap-truncation warning (`ordered.length > MAX_PROPS`
already evaluated, `:1011`) and before any prop row prints: it is inside the classification loop,
not inside `synthesizeValue`, which is never reached for the prop that overflows.

Two changes:

- Wrap the per-prop classification call (`typeToSchema`'s loop body, `:1016-1024`) in a `try/catch`
  narrowly matching `RangeError` (V8's catchable "Maximum call stack size exceeded" — safe to catch
  in Node because it fires with headroom on the JS call stack, not a native fault). On catch, the
  prop is reported the same way an unenumerable computed type already is
  (`warnUnenumerableProps`-style wording naming the prop and "TypeScript's type resolution recursed
  too deeply — likely a self-referential generic type"), and excluded from the schema, rather than
  the bare, unnamed "Error: Maximum call stack size exceeded" that currently reaches the CLI's
  top-level handler with exit code 2 and no attribution to a prop or a cause.
- The same guard wraps the whole `findComponentPropsType`/`typeToSchema` call in the top-level
  extraction entry point (`:252-268`), so a type that overflows before or during the classification
  loop itself — not just inside one prop's `getTypeOfSymbolAtLocation` — degrades to "props could
  not be resolved for `<component>`: type resolution recursed too deeply" instead of an uncaught
  process crash, matching `warnUnboundTarget`'s existing wording register (`:757-768`).

This does not change `synthesizeValue`'s existing depth/stack guards, which remain correct and
sufficient for *value* synthesis; it adds an equivalent safety net at the *type-classification*
layer, which had none.

## Changed contracts

- `typeToSchema`'s prop ordering before the `MAX_PROPS` cap changes from a two-bucket
  declared-locally/not partition to the three-tier rank in section 1. A test asserting today's
  exact tail-ordering of computed-type members (none exists — no test file matches `MAX_PROPS`,
  `declaredHere`, or `warnPropCap`, confirmed by search) is not broken by this change.
- `isNoiseProp`'s `isAmbientNoiseDeclaration` branch stops removing props from `kept` before the
  cap; those props now flow into `ordered` and are subject to ranking and, if the total exceeds 32,
  the cap and its warning. A component whose total prop count is reported today (post-filter) will
  report a higher total after this change whenever it has react/react-dom-declared inherited
  members — this is the intended fix, not a regression, but any test asserting a specific `N props
  were extracted` count for such a component needs its expected count updated.
- `resolveAnchorValue`/`resolveBaseValues` return `undefined` instead of a fabricated value for a
  degenerate `"object"`/`"reactnode"` schema with no preset override. Any test currently asserting
  `{}` or `"120fps-placeholder"` reaches a combo for such a schema needs updating to expect
  `undefined`.
- `opaqueReason` gains a branch for `ReactElement | Function`-shaped unions; a schema that was
  `kind: "reactnode", degenerate: undefined` for such a type becomes `kind: "object", degenerate:
  "<type> requires a real element or render function"`. `classifyType`'s existing `"reactnode"`
  branch narrows correspondingly.

## Does NOT include

- Composition of a compound component's sibling parts (`Tabs.Root` mounted without `Tabs.List`/
  `Tabs.Trigger`, etc.) — base-ui-F1, radix-primitives-F1. That is disclosure of *what was
  rendered*, owned by M80; this milestone owns the *prop schema* only, per `M76-M83-MAP.md`'s
  boundary statement ("M81 does not change composition").
- Widening ADR 0002 to runtime-form Vue `props: {}` / Options API components (element-plus-F6's
  `filter-panel.vue`) — needs a new ADR per `M76-M83-MAP.md`.
- Stylesheet selection and its disclosure (heroui-F3, chakra-ui F9, element-plus-F5,
  radix-primitives-F4) — M82.
- Environment/install preflight misdiagnosis (excalidraw-F1/F2/F3's uninstalled-`node_modules`
  react-dom/csstype misdiagnosis; chakra-ui-F3/F4's workspace-root config and csstype-type-only-import
  crashes; commerce-F3/F4's server-only preflight and `--no-preflight` fallback) — M76/M77/M78.
- Curve-mode's `[render error]` tag and `--wrap` hint disappearing (chakra-ui-F1), matrix's blank
  axis label on a degenerate 1-cell matrix (commerce-F5), the wrong-cause "missing provider" guess
  when the tool's own captured page error already names the real cause (base-ui-F2's remediation
  hint half) — diagnostics/hints, not schema; out of this milestone's file ownership.
- Vue-specific measurement defects unrelated to prop schema: element-plus-F2 (phantom zero-DOM on
  discrete combos despite a real root element), F3 (harness's own 404 misattributed as a component
  page error), F4 (memory-leak verdict not discounting same-run noise) — these are harness/DOM-count
  and isolation-mode defects, not prop-schema defects, and are out of scope here.
- `.ts` component files being hard-rejected (chakra-ui-F5), export-resolution picking a non-ideal
  multi-export default (chakra-ui-F7) — neither is in the `Closes` list for this milestone.
- Any change to `aria-*`/`data-*` filtering (`NOISE_PROP_NAME`, `:972`): stays a silent, hard,
  pre-cap filter, unchanged.

## Acceptance

Checkable against fixtures under `test/fixtures/` (or inline `ts.createProgram` sources in the unit
tests listed above), not against a cloned repository:

- A `Button` fixture with `interface ButtonProps extends ComponentPropsWithRef<'button'>,
  VariantProps {}` where `VariantProps` is a `tailwind-variants`-style computed type
  (`ReturnType<typeof tv>['variantKeys']`-shaped, zero-declaration members): `variant`/`size`
  survive a 32-prop cap alongside ~100 declared-in-`node_modules` passthrough props from the base
  `ComponentPropsWithRef` type.
- A fixture with `Omit<React.HTMLAttributes<HTMLElement> & React.ButtonHTMLAttributes<HTMLElement>,
  'type'>`: `onClick` is present in the resolved schema, and if the total exceeds 32, the existing
  `warnPropCap` message fires naming the true (uncapped) total.
- A fixture with `currencyCode: string`: the synthesized value is a real ISO 4217 code, not `"test"`.
- A fixture with an `Iterable<string>`-typed prop: the synthesized value is a real array, and
  `new Set(value)` does not throw.
- A `forwardRef<Elem, Props>(function Name(props: Props, ref) {...})` fixture (Fixture A) and a
  `forwardRef<Elem, Props>(({ a, b }, ref) => {...})` fixture (Fixture B) both extract a schema
  whose required/optional flags match the declared `Props` interface exactly; Fixture A's outcome
  today is known-passing (radix corroboration) and must not regress.
- A self-referential generic fixture (`interface Node<T> { value: T; children?: Node<T>[] }`,
  `defineProps<TableLikeProps<Node<string>>>()`-shaped) extracts a schema or a named degenerate
  warning — process exit code and stdout/stderr contain no bare `RangeError`/"Maximum call stack
  size exceeded" text.
- A schema entry with `degenerate` set (either kind `"object"` or `"reactnode"`) produces `undefined`
  in every generated combo (`generateCombinations`, `generateDeltaPairs`, `generateScalingCombos`,
  `generatePropMatrix`) unless a `<stem>.props.tsx` preset supplies that prop, in which case the
  preset value is used and `degenerate` is absent — matching `--explain-props`'s own report for the
  same schema.
