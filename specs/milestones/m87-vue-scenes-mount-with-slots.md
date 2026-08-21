---
kind: milestone
status: draft
tests:
  - test/unit/vue-support.test.ts
  - test/unit/vue-render-health.test.ts
---

# M87: Vue scenes mount with their slots

## Purpose

Two live Vue mount defects make a correct component look broken. primevue's `Accordion.vue`
crashes on mount with `TypeError: this.$slots.default is not a function` because the harness never
supplies a default slot. element-plus's `button.vue` reports `DOM=0` for all eight combos in the
combo phase while the scale-probe phase reports `DOM=2/6/21/51` for the same component, whose root
`<component :is="tag">` is unconditional — ground truth is that the combo phase is factually wrong.
Both are Vue entry-generation defects, not component bugs.

## Contract

### MUST

- A Vue component that reads `this.$slots.default()` or `slots.default?.()` receives a slot
  function, not a value.
- A component whose template has an unconditional root renders a non-zero DOM node count in the
  combo phase.
- When the combo phase and the scale-probe phase disagree about whether anything rendered, the run
  states which phase is believed and why.

### MUST NOT

- Report a render-health disagreement as the final answer when one phase is demonstrably correct.

### Invariants

- A component whose root is conditionally gated (`v-if`, `v-show`, `v-for`) keeps its current
  behavior: a combo that legitimately renders nothing must still be able to report zero DOM nodes.
- The control API surface (`mount`, `mountWrapperOnly`, `unmount`, `rerender`, `getContainer`) stays
  byte-identical for every renderer.

## Design

`generateVueEntry` (`src/harness.ts`) mounts a bare component via `h(${componentName}, { ...props })`
with no third (`children`/`slots`) argument, so Vue's runtime never populates `$slots.default` at
all — reading it as a value is `undefined`, and calling `undefined()` is exactly the observed
TypeError. The combo-phase mount now always passes a slots object with a `default` render function
(`() => []`), so `$slots.default` is callable whether or not the component ever inspects it. This
applies uniformly: passing an always-present, empty-returning default slot changes nothing for a
component that ignores `$slots` and fixes every component that treats `$slots.default` as callable.

The DOM-count disagreement is traced to a second, independent shape difference between the two
phases' render output, not to a Vue defect. Scale-probe mode's `renderComponent()` branch always
wraps its N component instances in an explicit `h("div", null, [...])` (`src/harness.ts`, the
`hasScale`-false scale branch). The plain combo-phase branch returns `h(${componentName}, {
...props })` directly, with no wrapping element, as the sole return value of `__120fpsRoot`'s own
`render()`. Scale-probe's reported DOM counts are exactly `N + 1` (2, 6, 21, 51 for N = 1, 5, 20,
50) — proof every scaled instance renders correctly once wrapped, and that the +1 is the wrapper div
itself. The unwrapped, bare-root combo-phase render is where the same component reports zero.

`vue-sfc.ts` gains `templateHasUnconditionalRoot(source, filename, compiler)`, a shallow, parse-only
check (matching `detectOptionsApiProps`'s existing pattern) over the `<template>` block's own root
tag: it returns `false` whenever the root element carries `v-if`, `v-show`, or `v-for` (or the
template cannot be read at all), and `true` otherwise. `buildAndServe` computes this once per Vue
component and threads it into `EntryOptions.vueUnconditionalRoot`. `generateVueEntry`'s non-scale
branch wraps its render in a stable `h("div", ..., [...])` container only when this flag is true —
matching the shape that already produces a correct nonzero count in scale-probe mode, and never
applied to a root that can legitimately render nothing.

With the root cause fixed at generation time, no combo produced by an unconditional-root component
can disagree with its own scale-probe measurement, so there is no disagreement left for the
downstream reporting layer (owned by Lane B/C) to adjudicate for this class of defect. The
disagreement-reporting mechanism referenced by the third MUST is Lane B/C's existing code
(`report.js`'s render-health mark, already observed working in the field-test evidence); this
milestone removes the specific miscount that fed it a false disagreement, and leaves a genuine
`v-if`-gated disagreement for that existing mechanism to keep handling as it does today.

## Open questions

None: the fix is scoped to the two concrete repro shapes and does not depend on any undecided
design choice.

## Verification

- Fixture Options-API SFC that calls `this.$slots.default()` inside a computed, mounted via the
  generated entry with no fixture/composition: generated entry must supply a callable
  `slots.default`.
- Fixture `<script setup>` SFC whose root is `<component :is="tag">` (unconditional): generated
  combo-phase render wraps in a stable container; generated scale-probe render is unaffected
  (already wraps).
- Fixture SFC whose root sits behind `v-if`: generated combo-phase render is NOT wrapped — the
  existing bare-root shape is preserved so a legitimately empty render still reports zero.
- `templateHasUnconditionalRoot` unit tests: unconditional root, `v-if` root, `v-show` root, `v-for`
  root, unreadable/absent template.
- Existing `generateEntry`/`vue-support.test.ts` assertions (control API surface, no React imports,
  wrapper slot wiring, auto-scale fan-out) keep passing unchanged.
