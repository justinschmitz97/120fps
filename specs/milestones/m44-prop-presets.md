---
kind: milestone
status: implemented
tests:
  - test/unit/m44-prop-presets.test.ts
  - test/e2e/m44-prop-presets.test.ts
---

# M44 — representative prop data (presets)

## Purpose

Synthesized prop values make the scene mount, but not resemble production: a
`data` prop gets 3 synthetic items, unions take their first member, render props
become stubs. The measurement is real but of an unrepresentative scene, and
users who notice stop trusting every number. Fixtures solve this fully but
manually; presets are the middle path — supply *values* without authoring a
*scene*.

## Contract

- A sidecar module `<stem>.props.tsx` or `<stem>.props.ts` adjacent to the
  component is auto-detected (`detectPropPresets`, mirroring fixture
  detection). Its default export is an object mapping prop names to a value or
  an array of values; a bare value is a one-element pool.
- Preset values **replace** a prop's pool rather than extending it. The point is
  to measure what the user says is representative, not that plus three
  synthesized values.
- Because they land in `PropSchema.values`, presets flow into every mode that
  reads schemas: combo generation, delta pairs, matrix cells, curve and
  auto-scale anchors.
- The preset module may export functions and JSX — that is its advantage over
  JSON. Function presets replace the identity-stub behaviour and participate in
  M18's callback-identity analysis unchanged.
- Preset names that are not props of the measured component produce
  `UNKNOWN_PRESET_PROPS_WARNING`; the run continues with them ignored.
- `Report.propPresets = { path, props }` records the module (projectRoot-relative
  posix) and the prop names it actually fed.
- The preset file joins the M39 source fingerprint: nothing in the component
  graph imports it, so an edited preset would otherwise reuse a verdict about
  different values.
- MUST NOT: apply in fixture mode (a fixture already owns its scene), execute
  the preset module in Node, or silently drop unknown names.

## Design

### Transport: literals travel, everything else keeps its position

The crux the draft left open. Combo generation runs in Node against serialized
values, and a `.tsx` preset's functions and JSX cannot cross the CDP boundary.
The resolution is a split decided per value, not per module:

- **Literal expressions** (strings, numbers, booleans, `null`, `undefined`,
  negative numbers, and arrays/objects composed of them) are evaluated from the
  AST and travel as themselves. Deltas, matrix cells and report rows compare
  real data.
- **Everything else** becomes `{ __120fps_preset: <propName>, index: <n> }` — a
  position, not a value. The harness entry imports the preset module and
  substitutes the real value at render time (`presetImportLine`,
  `presetResolverBlock`, `presetResolveStatement`), extending the existing
  `FUNCTION_MARKER` precedent.

The module is parsed, never executed: a preset imports browser-only code and
JSX, and running it in Node would be a second, worse module loader.

Substitution happens once at `mount` and once at `rerender` rather than at every
render site, so scale fan-outs and composed scenes get resolved props without
extra cases. An entry without a preset contains no reference to the module.

## Hardening

| # | Hypothesis | Result |
|---|---|---|
| H1 | A module without a default export throws | Pass — yields nothing |
| H2 | A missing preset file throws | Pass — yields nothing |
| H3 | A bare (non-array) value is misread | Pass — one-element pool |
| H4 | An empty pool blanks out the prop | Pass — synthesis retained |

## Deferred

- TSDoc `@example` as a second value source. The sidecar covers the
  function-prop case that motivates presets; `@example` would be JSON-only and
  is a separate extraction change.
- Storybook `args` reuse (`*.stories.tsx`). The richest source of real values,
  but CSF parsing is a project of its own. The preset contract is shaped so an
  importer can feed `PropPresets.entries` later.
- Sampling priority for preset dimensions when a preset array multiplies into
  the combo cap.
- Per-value labels in matrix/delta rows (`data: preset[2]` reads poorly).
