---
kind: milestone
status: draft
tests:
  - test/unit/harness-fault.test.ts
---

# M85: A harness-caused failure is not the component's verdict

## Purpose

`npx 120fps ./Separator.tsx` reports `Result: FAIL` on a correct, widely-shipped Radix component
because the harness synthesized `asChild=true` without the single React element child that flag
contractually requires: `Primitive.div failed to slot onto its children`, zero DOM nodes, counted as
a failure. The tool already refuses to charge a harness-caused *network* request against a
component's verdict (`isHarnessInternalNoise`, `src/page-errors.ts`); this milestone generalizes the
same principle to renders and crashes. A combo's failure is the component's fault only when nothing
the harness itself supplied explains it.

Closes: radix-primitives-F3, element-plus-F2, commerce-F1, and the general rule they share.

## Contract

### MUST

- A combo whose failure is traceable to a value with `provenance: "placeholder" | "heuristic" |
  "contract"` sets `ComboReport.harnessFault` and does **not** count as a component failure.
- A prop whose truthiness imposes a contract on other props (`asChild`, `as`, `render`, and any
  boolean whose `true` branch changes what `children` must be) is either synthesized together with a
  satisfying value for the props it constrains, or excluded from the combo set with a disclosure.
- The report states, per affected combo, which synthesized value caused the fault and what was done
  about it.
- `report.pass` ignores `harnessFault` combos.

### MUST NOT

- Report `FAIL` for a component whose only failing combos are `harnessFault`.
- Silently drop the affected combo. Exclusion is a disclosure, not a deletion.

### Invariants

- A combo with `harnessFault` set always also carries `renderHealth: "error"` and a non-`"fail"`
  `verdict`: the underlying facts (nothing rendered, the page threw) stay visible even though the
  fault is not charged to the component.
- `harnessFault.propName` always names a prop present in that combo's `props`.
- A component whose failures are *not* traceable to a risky-provenance value is unaffected: its
  verdict, `report.pass`, and disclosure text are byte-identical to the pre-M85 behavior.

## Design

`ComboReport.harnessFault` (new, `src/report.ts`):

```ts
harnessFault?: {
  propName: string;
  value: unknown;
  provenance: "declared" | "preset" | "heuristic" | "placeholder" | "contract";
  evidence: string;
};
```

`provenance` is Lane B's cross-lane field on `PropSchema` (`src/prop-gen.ts`, M84). It does not exist
on the type as of this milestone's authoring; consumption reads it through a local structural
extension (`PropSchema & { provenance?: PropProvenance }`) so the code compiles whether or not M84
has landed, and degrades to "never detect a fault" when every schema's `provenance` is `undefined`
(no crash is ever wrongly exonerated for lack of the field — the detector requires positive evidence
to fire, never assumes it).

`detectHarnessFault(combo, schemas)` (`src/analyze.ts`) runs once per combo, after the combo's tier
and verdict are finalized, and only when `combo.verdict === "fail"` and `combo.renderHealth ===
"error"` (a fatal render crash — the "renders and crashes" half of the existing network-request
rule, generalized):

1. **Contract props.** Any schema with `provenance === "contract"` whose value in `combo.props` is
   truthy is flagged immediately: a contract prop is by construction a value whose truthiness imposes
   a requirement the synthesizer is not certain it satisfied (M84's own definition), so a crash while
   it is truthy is presumptively the harness's doing. This is the mechanism radix's `asChild=true`
   fires on.
2. **Placeholder/heuristic props.** A schema with `provenance` of `"placeholder"` or `"heuristic"`
   is flagged only when its value (or, for an object/array prop, one of its own scalar descendant
   values — covers a nested field like `label.currencyCode`) appears verbatim inside the combo's
   captured `pageErrors` text. This is the same "evidence, not presence" standard
   `isHarnessInternalNoise` already applies to a 404 URL shape: a placeholder value's mere existence
   in a combo is not evidence it caused the crash — most placeholder values never do — so a textual
   match against the actual thrown message is required before a real component defect can be waved
   away. This is the mechanism commerce's nested `currencyCode: "text"` fires on
   (`Invalid currency code : text`).

The first match wins; `evidence` is the matching captured page-error text (or, for a contract prop
with no error-text correlation available, a description of the unmet contract). No match leaves the
combo's `fail` verdict untouched — this is a narrowing filter, never a general crash-suppressor.

When a fault is found: `combo.harnessFault` is set and `combo.verdict` is demoted from `"fail"` to
`"warn"` (the underlying facts — `renderHealth: "error"`, the captured `pageErrors` — stay on the
combo unchanged, so nothing is hidden, only the verdict changes). `report.pass` is computed as
`combos.every((c) => c.verdict !== "fail" || c.harnessFault)`, satisfying the "ignores harnessFault
combos" rule directly rather than only incidentally through the verdict demotion.

Disclosure (`src/report.ts`):

- The combo table's verdict cell gains `[harness fault: <propName>]` alongside the existing
  `[render error]` mark.
- `appendPageErrors`'s per-combo "counted as a failure, not a pass" line is replaced, for a
  `harnessFault` combo, with a line naming the prop, its synthesized value, and that the combo is
  excluded from the verdict rather than counted against it.
- `hintsForReport` (`src/hints.ts`) suppresses the generic `renderError` hint for a `harnessFault`
  combo (that hint's "an undefined prop needs a preset" framing does not fit a value that is defined,
  just wrong) and adds a new `harnessFault` hint naming the `<stem>.props.tsx` escape hatch for the
  specific prop.

## Open questions

None. Where the cross-lane `provenance` field is absent, the detector is inert by construction
(documented above), which is the agreed fallback per this lane's brief.

## Verification

- Fixture component with an `asChild`-style contract prop that throws when given non-element
  children: combo `renderHealth === "error"`, `harnessFault` set with `provenance: "contract"`,
  `verdict !== "fail"`, `report.pass === true`.
- Nested placeholder value (`label.currencyCode`-shaped): schema `provenance: "placeholder"` on the
  outer object prop, page-error text containing the placeholder value: `harnessFault` set, verdict
  demoted.
- A schema with risky provenance present in a combo whose page-error text does **not** mention its
  value: `harnessFault` stays unset, verdict stays `"fail"` (negative case for the "presence is not
  evidence" rule).
- A crash with no schemas supplied at all (`provenance` universally `undefined`): `harnessFault`
  never fires, byte-identical pre-M85 behavior (tolerates M84 not having landed yet).
- A component whose only failures are genuine (no risky-provenance prop involved): unaffected,
  `report.pass === false`, `MUST NOT` case covered by a negative test.
- CLI table and JSON report both carry the disclosure for a `harnessFault` combo; `hintsForReport`
  excludes `renderError` and includes the new hint for that report.
