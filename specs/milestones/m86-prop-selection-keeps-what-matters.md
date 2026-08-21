---
kind: milestone
status: draft
tests:
  - test/unit/prop-cap-source-reference.test.ts
  - test/unit/prop-cap-required.test.ts
  - test/unit/prop-cap-preset-exempt.test.ts
  - test/unit/prop-cap-handler-generic.test.ts
---

# M86: Prop selection keeps the props that matter

## Purpose

The 32-prop cap and its M81 three-tier rank correctly promote a locally-declared or handler-named
prop ahead of inherited noise, but two gaps remain even under correct tiering. A prop the component's
own function body references by name (`props.onClick`, or a destructured `{ onClick }`) carries a
signal M81's rank never reads — it only looks at where the prop's *type* is declared, not whether the
component's own *code* uses it — so a purely-inherited handler with no local type declaration still
loses a stable-sort tiebreak to hundreds of same-tier inherited members. A **required** prop can be
dropped by the cap outright, because tiering does not distinguish required from optional: shadcn's
`chart.tsx` loses its required `config: ChartConfig` this way and then fails to render on every combo.
Separately, the escape hatch for a prop the cap does drop — a `<stem>.props.tsx` preset — cannot
currently restore it: presets are applied to the schema *after* the cap already ran, so a preset
naming a truncated prop is rejected with a message that is false for that prop (it is not absent, it
was truncated).

## Contract

### MUST

- A prop the component's own source references by name outranks an inherited prop it does not.
- A **required** prop is never dropped by the cap. shadcn's `chart.tsx` loses its required
  `config: ChartConfig` and then fails to render 100% of the time.
- A handler prop ranks as a handler even when its type flows through an unresolved generic parameter.
- A `<stem>.props.tsx` preset can name a prop the cap dropped and have it **restored** to the measured
  schema. Presets are applied before the cap, or preset-named props are exempt from it.
- The cap warning states the truth about what a preset can do.

### MUST NOT

- Report `"supplies a value for X, which is not a prop of the measured component"` for a prop that IS a
  prop and was merely truncated. That message is currently emitted and is false.

### Invariants

- A required prop's presence in the measured schema does not depend on its rank tier: it is included
  unconditionally, before the tiered optional pool is capped to fill whatever budget remains.
- The uncapped total `warnPropCap` reports is the true `kept.length` (post-noise-filter, pre-cap)
  regardless of how many required or preset-exempt props bypassed the ranked slice — a user reading
  "N props were extracted" sees the same N whether or not this milestone's exemptions applied to their
  component.
- `applyPropPresets` (`src/prop-presets.ts`) is unchanged: it still replaces a value pool for a prop
  already present in `schemas`. What changes is only that a preset-named prop is now reliably present
  in `schemas` to begin with.

## Design

**Own-source reference outranks declaration site** (`src/prop-gen.ts`). A new tier, ranked ahead of
M81's Tier 1 ("variant surface"), for a prop name the target component's own function body references
— either as a destructured parameter name (already computed by `destructuredParameterNames` for the
self-consistency guard, reused here) or as `<paramIdent>.name` member access, or a local `const { name
} = <paramIdent>` destructuring inside the body. `sourceReferencedPropNames(fn)` walks the bound
function's body once per extraction and returns the name set; `propRank` promotes any prop in that set
regardless of how its *type* resolves. This is deliberately a source-text signal, not a type-flow
signal: ant-design's `Button.tsx` calls `props.onClick?.(...)` and wires `onClick={handleClick}`
while `onClick`'s type is purely inherited through `MergedHTMLAttributes` with no local redeclaration
— M81's existing tiers cannot see this, because they only ever look at where the prop's type is
declared.

**Required props bypass the cap** (`src/prop-gen.ts`, `typeToSchema`). `kept` is partitioned into
required and optional before ranking. Every required prop is included unconditionally; the ranked
tier system (source-referenced, variant surface, locally-meaningful/handler, everything else)
operates only on the optional pool, filling `MAX_PROPS - requiredCount` slots (clamped at zero — a
component with more than 32 required props keeps all of them, exceeding the nominal budget, because
dropping a required prop breaks rendering outright while dropping an optional one degrades a test
case). `warnPropCap`'s reported total is `kept.length` either way, so the disclosed count never
depends on this split.

**Handler detection survives an unresolved generic** (`src/prop-gen.ts`, `propRank`). The existing
`EVENT_HANDLER_NAME.test(name) && nonUndefined.some((t) => t.getCallSignatures().length > 0)` check
promotes a handler by confirming its type is genuinely callable. Extensive probing against
polymorphic-element and conditional-type shapes (`Omit<JSX.IntrinsicElements[E], ...>`, deferred
conditional types, mapped-type handler collections) did not reproduce a case where a real function
type's `getCallSignatures()` returns zero through a generic — TypeScript's checker resolved every
shape tried. This milestone adds a narrow, low-risk fallback for the failure signature a generic
defeat is most likely to produce even where it could not be reproduced directly: an
`EVENT_HANDLER_NAME`-matching prop whose non-`undefined` type resolves to `any` or `unknown` (rather
than a concrete non-callable type) is also promoted, on the reasoning that a deliberately-non-function
prop named `/^on[A-Z]/` would resolve to a concrete type (a string, a union), not `any`/`unknown` — see
`## open` for the honesty note on this branch's confidence.

**Preset exemption from the cap** (`src/prop-gen.ts`, `typeToSchema`). `typeToSchema` already has
`fileName` (the absolute component path); it calls the same `detectPropPresets`/`loadPropPresets`
`prop-gen.ts` already imports from `prop-presets.ts` (no new cross-file dependency — both are Lane B
files) to obtain the set of prop names a preset (if any) declares, and promotes every name in that set
to the top rank tier, above source-referenced props. This makes the exemption self-contained inside
`prop-gen.ts`: the caller in `analyze.ts` still detects and applies the preset exactly as it does
today (`applyPropPresets` runs after extraction, replacing the now-reliably-present schema's value
pool), but the schema the cap produces already includes whatever the preset names, so
`applyPropPresets`'s existing `known.has(name)` check finds it and the "not a prop of the measured
component" message — which was only ever false for a prop the cap had truncated — no longer fires for
that case. The message's wording is unchanged: once the underlying behavior matches what it already
claimed ("choose the props that matter"), it does not need new text to become true.

## Open questions

None blocking implementation. Recorded as a confidence note, not a blocker: the "unresolved generic
defeats handler detection" mechanism could not be reproduced against several realistic polymorphic and
conditional-type shapes; the `any`/`unknown` fallback this milestone adds is a defensive widening for
the most plausible failure signature, not a verified fix for a specific reproduced case. If a future
corpus run still shows a real handler losing Tier promotion, the type-flow check itself — not just its
fallback — needs re-investigation with the actual failing source available.

## Verification

Fixtures under `fixtures/m86/`:

- A component with more than 32 props including a required one (`config: ChartConfig`-shaped) and an
  own-referenced `onClick` (present in the type only via inheritance, referenced in the function
  body): both survive the cap.
- A polymorphic generic component (`Omit<JSX.IntrinsicElements[E], ...>`-shaped) with `onClick`: the
  handler ranks ahead of Tier-3 volume.
- A preset naming a prop the cap would otherwise drop: the prop is present in `--explain-props`'s
  schema and the preset's values are applied, with no "not a prop of the measured component" warning.
- Existing `fixtures/m81/*` fixtures and their tests are unaffected (regression: M81's tier system is
  extended, not replaced).
