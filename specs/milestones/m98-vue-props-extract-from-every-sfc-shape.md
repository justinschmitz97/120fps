---
kind: milestone
status: draft
tests:
  - test/unit/vue-dual-block-props.test.ts
  - test/unit/preset-adds-missing-props.test.ts
  - test/unit/vue-support.test.ts
---

# M98: Vue props extract from every SFC shape the compiler accepts

Lane B (+ I2, I3 in Lanes A/C). Closes nuxt-ui-F1 (blocker), primevue-F1 (blocker),
element-plus-F3, element-plus-F5. Root causes: `verify/V5-vue-prop-extraction.md`,
`verify/V4-element-plus-gate.md`.

## Purpose

Two blockers, both structural rather than per-component.

122 of 124 `.vue` files in nuxt-ui declare their props interface in a companion
`<script lang="ts">` block and consume it from `<script setup>` — the only way an SFC can
`export interface` its props type, and idiomatic Vue 3. `parseSfcScript` fed only the setup
block into the virtual module, so `defineProps<BadgeProps>()` named a type that was not in the
program. Extraction returned `[]` with no warning, and the user saw the generic "extraction may
have failed" hedge (V5).

271 of 279 `.vue` files in primevue declare props through `extends: BaseX`. That form is an ADR
0002 scope exclusion, and the warning naming it offers `<stem>.props.tsx` as the escape hatch.
`applyPropPresets` is `schemas.map(...)`: with `schemas` empty the map is empty, every preset key
falls into `unknown`, and the user is told the props they just supplied "are not a prop of the
measured component" — in the line below the one telling them to supply them (V5).

## Contract

- inputs: a `.vue` entry, its `<stem>.props.tsx` when present, the project's Vue compiler.
- outputs: `PropSchema[]` plus warnings naming any exclusion or resolution failure.
- constraints: ADR 0002's Vue scope exclusions stand; the project's own Vue compiler parses.
- non-goals: the `.tsx`-in-a-Vue-project refusal (I2, Lane A), `--framework` forwarding
  (I3, Lanes A and C), Options-API `extends`/`mixins` extraction itself.

### MUST (from the map, refined)

- `parseSfcScript` feeds both `descriptor.script` and `descriptor.scriptSetup` into the virtual
  module, script block first, so a props interface declared in `<script lang="ts">` resolves for
  `defineProps<T>()` in `<script setup>`.
- When a `defineProps` type argument resolves to an error type, the warning names the unresolved
  type and the file it was expected in (the site previously returned silently).
- `applyPropPresets` appends a schema (`provenance: "preset"`, `required: false`, type inferred
  from the preset value) for every preset key absent from extraction;
  `UNKNOWN_PRESET_PROPS_WARNING` fires only when extraction produced at least one schema.
- A `string | number` (and `number | string`) prop synthesizes a member and is typed `union`, with
  the same disclosure every other union gets (element-plus-F3).
- A component using `setup()` with a runtime `props:` object is described as "runtime props object"
  (Composition API), never as "Options API" (element-plus-F5).

### MUST NOT

- Re-enable extraction for Options-API `extends`/`mixins` props (still excluded by ADR 0002); the
  change is that the documented escape hatch now works for them.
- Change what `parseSfcScript` returns for an SFC with no `<script setup>`. That `undefined` is
  load-bearing: `extractVueProps` uses it to decide the file is an Options-API candidate, and
  `preflight.ts:329` uses it to decide the file contributes no module to the import graph.

## Design

### 1. Both script blocks, companion first

`parseSfcScript` still requires a `<script setup>` block to return anything at all (see MUST NOT).
When one exists and a companion `<script>` block also exists, the companion's content is prepended,
separated by a newline — the order Vue's own `compileScript` emits. `lang` is the stronger of the
two blocks' languages (`tsx` > `ts` > whatever setup declared), so the virtual file gets the script
kind that parses both.

Duplicate imports across the two blocks produce a TypeScript redeclaration diagnostic. Diagnostics
are never read here: `getTypeFromTypeNode` resolves regardless, which is why the concatenation is
safe without deduplication.

### 2. An unresolved type argument says so

`defineProps<BadgeProps>()` on a name with no declaration yields TypeScript's error type — `any`
with zero properties — which `looksLikePropsType` rejects, and the function returned `[]` with no
`sink?.()` call. That silence is what routed nuxt-ui to `ZERO_PROPS_WARNING`.

Telling an unresolved name from a genuinely empty `defineProps<{}>()` is what makes the new message
true: an unresolved type reference has no symbol at its type name.
`VUE_UNRESOLVED_PROPS_TYPE_WARNING` fires only for that case, naming the type's source text and the
SFC.

### 3. A preset adds props when extraction produced none

`applyPropPresets` gains an append path, taken only when `schemas.length === 0`:

| extraction | preset key not in schemas | outcome |
|---|---|---|
| produced nothing | any | appended as `provenance: "preset"`, `required: false`, kind inferred from the value |
| produced schemas | key absent | `unknown`, `UNKNOWN_PRESET_PROPS_WARNING` as before |

The map's clause "`UNKNOWN_PRESET_PROPS_WARNING` fires only when extraction produced at least one
schema" is what fixes the branch point. Appending unconditionally would make that clause vacuous
and would silently measure a mistyped preset key as though it were a prop, which is the disclosure
this codebase does not drop. Recorded here as a deliberate reading of the map.

Kind inference from the preset's own values: `boolean`/`number`/`string` by `typeof`, `array` for an
array, `object` for a plain object, `unknown` for a `PresetRef` (a function or JSX the preset file's
AST cannot read as a value) and for `null`/`undefined`. Values of differing kinds make it `union`.

### 4. `string | number` is a union

A union of the bare primitives `string` and `number` reached neither the string-literal branch nor
the number-literal branch nor `classifyTarget.flags & String`, so it fell through to the opaque
path: `kind: "unknown"`, and `collapsedUnionBranches` deliberately suppressed the disclosure because
nothing had collapsed. It is now classified `union` with one synthesized member per branch (the
string branch through `namedStringValue`, so `currencyCode: string | number` still gets a valid
currency), `provenance: "placeholder"` because the values are synthesized, and
`collapsedUnionBranches` reports it like every other union. Scoped exactly to a union whose
non-`undefined` members are bare `string` and bare `number`; `string | boolean`, `Foo | Bar` and
every other mixed shape keep their current behavior.

### 5. `setup()` is Composition API

`detectOptionsApiProps` returns a fourth form, `"setup-props"`, when the default-exported object
literal has both a `props` key and a `setup` key — element-plus's `select.vue` shape
(`defineComponent({ props: selectProps, setup(props, { emit, slots }) {…} })`).
`VUE_SETUP_RUNTIME_PROPS_WARNING` describes it as a runtime props object read by `setup()` (Vue's
Composition API) and never says "Options API". `extends` plus `setup` stays `"extends"`:
inheritance is an Options-API form whatever the component's own body uses.
`isVuePropsScopeExclusionWarning` recognizes the new warning, so `disclosureReason: "propsExcluded"`
covers it.

## Open questions

- `VUE_UNRESOLVED_PROPS_TYPE_WARNING` is a resolution failure rather than a scope exclusion, so it
  is deliberately not part of `isVuePropsScopeExclusionWarning`. `analyze.ts:2103` will still stack
  the generic `ZERO_PROPS_WARNING` on top of it. `isVueUnresolvedPropsTypeWarning` is exported for
  Lane C to add there; recorded as an interface request rather than an edit to Lane C's file.

## Also fixed here

`VUE_OPTIONS_API_PROPS_WARNING` ended "Add Badge.props.tsx next to it" unconditionally. With the
preset file on disk — the very run that now measures its three props — that sentence told the user to
create what the run had just loaded (V5 recorded the pair of adjacent contradicting lines).
`presetRemedyClause` states which of the two is true; the same clause covers the runtime-`defineProps`
and setup-props warnings. `UNTYPED_JS_COMPONENT_WARNING` (M97) already behaved this way.

`extractVueProps` now passes its sink into `typeToSchema`, matching the React path. Without it a Vue
prop's collapsed-union, prop-cap and recursion disclosures went to stderr and never reached the
`warnings` list a dry run prints.

## Verification

### Unit

`pnpm vitest run test/unit/vue-dual-block-props.test.ts test/unit/preset-adds-missing-props.test.ts`
— 25 passed. Fixture `fixtures/vue-dual-block/`: `DualBlock.vue` and `DualBlockDefaults.vue`
(companion interface + `<script setup>`, the second through `withDefaults`), `UnresolvedImport.vue`
(companion block importing a type from `#build/nowhere/missing`), `PrimitiveUnion.vue`
(`string | number` and `number | string`), `SetupRuntimeProps.vue` (`defineComponent({ props, setup })`),
`OptionsExtends.vue` + `OptionsExtends.props.tsx` + `BaseBadge.vue` (primevue's shape with the escape
hatch).

`test/unit/prop-synthesis-edge-cases.test.ts` H15/H16 encoded the pre-M98 outcome for
`string | number` (degenerate, no disclosure). H15 now pins the same guarantee on
`fixtures/m60/unsynthesizable.tsx` (a required `Store` and `Promise<string>`), H16 pins it on the
same fixture's `span?: bigint`, and a new case states M98's contract for `token: string | number`.

`pnpm vitest run test/unit/ --maxWorkers=4 --reporter=dot` — Lane B's files: no failures. Four
files failed on other lanes' in-flight work (`killed-run-cleanup`, `curve-empty-render-point`,
`scale-probe-edge-cases`, all Lane A/C).

### Real repositories

nuxt-ui @ be58f3f — `node /c/Projekte/120fps/dist/cli.js src/runtime/components/Badge.vue
--explain-props` (`logs/fix-b-nuxt-badge-explain.log`, exit 0). Before: `Props (0): (none extracted)`
plus the generic `ZERO_PROPS_WARNING`. Now:

```
Props (14):
  square        boolean  optional  true, false
  leading       boolean  optional  true, false
  trailing      boolean  optional  true, false
  as            unknown  optional  "span"
  label         union    optional  "test", 1
  color         unknown  optional  (no values)
  variant       unknown  optional  (no values)
  size          unknown  optional  (no values)
  class         unknown  optional  (no values)
  ui            object   optional  {}  [degenerate: no synthesizable members on { [x: string]: SlotClass; }]
  icon          unknown  optional  (no values)
  avatar        object   optional  {"src":"data:image/gif;base64,R0lGODlhA…
  leadingIcon   unknown  optional  (no values)
  trailingIcon  unknown  optional  (no values)
```

Every name the map asked for (`as label color variant size square class ui`) is present. The four
theme-derived props degrade to `unknown` because `#build/ui/badge` is unresolvable outside a Nuxt
build, exactly the P3-acceptable outcome V5 predicted. `label` is `union "test", 1` — element-plus-F3's
shape working on a second repository.

primevue @ d4374cb — `packages/primevue/src/badge/Badge.vue --explain-props` with a temporary
`Badge.props.tsx` (`export default { value: '2', severity: 'success', size: 'large' };`, removed
afterwards; `git status --porcelain` empty). Before: `Props (0)` plus "…which are not a prop of the
measured component. Those values were ignored." Now:

```
  presets:  Badge.props.tsx
Props (3):
  value     string  optional  "2"
  severity  string  optional  "success"
  size      string  optional  "large"
Warnings:
  …Badge.vue declares props through Vue's Options API ("extends"), a runtime form ADR 0002 deliberately
  does not read: extraction did not fail and the component is not broken. Badge.props.tsx next to it
  already supplies the values measured.
```

element-plus @ HEAD — `packages/components/badge/src/badge.vue --explain-props`
(`logs/fix-b-element-badge-explain.log`, exit 0). Before: `value unknown optional ""`, no warning:

```
  value       union    optional  "", "test", 1
  Warning: prop "value" in …badge.vue is a union of 2 different shapes (string | number); measured as
  union. Add badge.props.tsx to choose a different branch.
```

`packages/components/select/src/select.vue --explain-props`
(`logs/fix-b-element-select-explain.log`, exit 0). Before: `declares props through Vue's Options API
("props")`:

```
  …select.vue declares props through a runtime props object read by setup() (Vue's Composition API), a
  runtime form ADR 0002 deliberately does not read: extraction did not fail and the component is not
  broken. Add select.props.tsx next to it to supply typed values for measurement.
```

Cleanup: `git status --porcelain` empty in nuxt-ui, primevue and element-plus; no
`.120fps-harness-*` and no `120fps-report.json` (every run was a dry run).
