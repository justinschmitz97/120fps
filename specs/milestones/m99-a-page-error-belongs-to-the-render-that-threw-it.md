---
kind: milestone
status: draft
tests:
  - test/unit/transition-page-error-attribution.test.ts
  - test/unit/harness-fault.test.ts
  - test/unit/harness-fault-harden.test.ts
---

# M99: a page error belongs to the render that threw it

## Purpose

Lane C. Closes: radix-primitives-F1, base-ui-F1, chakra-ui-F3. Root cause:
`C:\Projekte\120fps-fieldtest\verify\V1-page-error-attribution.md`.

V1 separates two independent defects that co-occur on `asChild` components and were reported as one:

- **D1 — attribution window.** The rerender pass drained the page-error buffer once per combo, and
  that one window spanned the prop-delta sub-probe, which deliberately rerenders into
  `combos[ci+1]`'s props (`measure.ts:1519-1546`). An error raised by the *next* combo's props landed
  on combo `ci`'s row, `renderHealth`, `harnessFault` input and verdict. Radix `label.tsx`: combos #1
  and #6, neither of which carries `asChild` at all, both printed
  ``Primitive.label failed to slot onto its children. Expected a single React element child or `Slottable`.``
  — an error `Primitive.label` can only raise when `asChild` is truthy, which combos #2 and #7 (their
  successors) are. Base UI `SelectRoot`: `combos[0]` (`open: true`, `defaultOpen: true`) carried a
  controlled→uncontrolled transition warning that combo #0 in isolation never transitions into;
  `combos[1]` is the uncontrolled one.
- **D2 — harness-fault evidence.** `detectHarnessFault`'s contract branch (`analyze.ts:444-458`)
  returned on presence of a truthy `asChild`/`as`/`render` alone, reading `errorText` only to fill
  the `evidence` string it then presents as proof. Chakra `tabs.ts`: combo #0 (`asChild: true`) was
  demoted to `warn` with evidence
  ``useContext returned `undefined`. Seems you forgot to wrap component within <ChakraProvider />``,
  while combos #2-#5 (scale probes, `props: {}`, `asChild` never set) failed on the byte-identical
  error. Identical defect, split verdicts, and a FAIL count that varied with how many sampled combos
  happened to draw `asChild: true`. The branch immediately below it (placeholder/heuristic,
  `analyze.ts:462-472`) already requires the value to appear in the error text
  (`valueEvidencedInText`, `:495`); the contract branch was the one branch in the function that
  contradicted the function's own header comment (`:425-433`, "Requires positive evidence per
  provenance class, never fires on presence alone").

## Contract

### MUST

- Errors captured during the prop-change rerender toward `combos[ci+1]` are reported as a transition
  (`ci → ci+1`) on row `ci` and excluded from that combo's `renderHealth`, `harnessFault` and
  verdict. They remain in JSON (`combos[ci].transitionPageErrors`) and in the console row tag.
- `detectHarnessFault`'s contract branch requires the captured error text to evidence the contract
  prop or its mechanism (`asChild`, `Slot`, `Slottable`, `cloneElement`, `render`), the same bar the
  placeholder branch applies; otherwise the combo fails on its own terms and the provider hint
  pipeline runs.
- The interaction pass is audited for the same window (result stated below, with file:line).

### MUST NOT

- Drop any error from JSON.
- Move an error to a different combo's verdict.

### Invariants

- A transition disclosure names the window it observed, never a cause it did not establish: the
  wording is "errors raised while transitioning to combo N+1", never "caused by combo N+1".
- `pageErrors` keeps its existing meaning (this combo's own mount and stable-rerender windows), so
  every message that was on a combo before this milestone and is still that combo's own is still
  printed in the same place.

## Interaction-pass audit (M99's third MUST)

**The interaction (explore) pass does not share the bleed, because it performs no per-combo error
attribution at all.** `attachPageErrorCapture` is called once per explore session
(`src/explorer.ts:462`); its only two consumers are `gotoWithErrorContext` (`:470`) and
`enrichTimeoutError` (`:480`), both on the harness-entry path. `errorCapture.drain()` does not appear
anywhere in `src/explorer.ts`, and `ExploreResult` carries no `pageErrors` field, so no explore-phase
error is ever written onto a combo. Each iteration mounts `combos[ci]` only (`explorer.ts:508`
`const props = combos[ci]`) and never a neighbour's props, so even if attribution were added later
the window would be single-combo by construction.

For completeness, the mount pass (`measure.ts:1615-1733`) was re-checked and is clean: it mounts
`combos[ci]` only, drains at `:1705`, and merges the vsync-bail carry-over at `:1714`. The bleed was
exclusive to the rerender pass, as V1 states.

## Design

### D1 — transition errors (consumes Lane B's I4)

Lane B split the rerender pass's single window into two (`src/measure.ts`): `RerenderResult.pageErrors`
now closes before the prop-change block, and a new
`RerenderResult.transitionPageErrors?: TransitionPageErrors` (`measure.ts:1348`, `:1364`, helper
`runWithSplitErrorWindows` `:1372`, call site `:1589`) closes after it, carrying
`{ toComboIndex, errors: PageErrorDrain }`.

Lane C consumes it:

- `ComboReport.transitionPageErrors?: { toComboIndex: number; errors: string[] }` (`src/report.ts`),
  rendered through the same `renderDrain` every other page-error list uses, so a capped window keeps
  its `(+N more dropped)` entry.
- `buildReport` (`src/analyze.ts:596`) assigns it from `rerenderResult.transitionPageErrors` and
  leaves the `mergeDrains(mount.pageErrors, rerenderResult?.pageErrors)` line untouched. Because the
  transition drain is never merged into `pageErrors`, exclusion from `renderHealth` (computed from
  `pageErrors?.fatal`), from `detectHarnessFault` (reads `combo.pageErrors`) and from the verdict
  (`computeVerdict` reads `renderHealth`, timings and interactions, never `pageErrors`) follows from
  the assignment rather than from four separate filters that could drift apart.
- Console row tag (`renderHealthMarks`, `src/report.ts:861`): `[→ #N: K page errors]`, printed
  independently of the combo's own `[K page errors]` tag so a row can carry both.
- Console detail (`appendPageErrors`, `src/report.ts:880`): a combo with transition errors appears in
  the `Page errors` block under its own heading line naming the transition and stating what the
  window proves, followed by the messages.

Lane B's caveat, carried into the wording verbatim: the transition window also spans the
`mountAndWait(page, props)` that precedes each `rerenderAndTrace(page, cdp, nextProps)` inside the
delta loop, so a *non-deterministic* own-props mount error inside that loop lands in the transition
bucket. A deterministic own-props error still appears in the stable window as well, which is why
`pageErrors` keeps its meaning. The disclosure therefore claims only the window ("raised while
transitioning to combo N+1"), never the cause.

### D2 — contract-branch evidence bar

The contract branch gains the same shape the placeholder branch has: a positive-evidence predicate,
`contractEvidencedInText(propName, errorText)`, and `undefined` when it fails.

Two evidence forms are accepted, and the split exists because the mechanism names and the prop names
have very different false-positive profiles:

1. **Mechanism identifier**, matched case-insensitively on a word boundary: `asChild`, `slot`,
   `slottable`, `cloneElement`. These are distinctive enough that their appearance in a page's error
   text is itself evidence the slot/clone contract is what failed. Case-insensitive because the real
   messages vary (`Slottable` in Radix's own text, "failed to slot onto its children" in the
   truncated form the existing fixtures use).
2. **The contract prop's own name in a prop-shaped position**: quoted (`"as"`, `'as'`, `` `as` ``),
   followed by `=` or `:` (JSX or object position), preceded by `.` (`props.as`), or followed by the
   word `prop`. A bare word-boundary match is rejected for this class because `as` and `render` are
   ordinary English words that appear in unrelated error prose; `CONTRACT_PROP_NAME`
   (`prop-gen.ts:2116`) is `/^(asChild|as|render)$/`, so two of its three members would otherwise
   match almost any sentence.

An empty `errorText` no longer produces a fault at all: the old fallback evidence string
("`asChild` was synthesized truthy with no value supplied for the props it constrains") asserted a
causal claim from zero observation, which is the same defect at a smaller scale.

Chakra's ``useContext returned `undefined`. Seems you forgot to wrap component within <ChakraProvider />``
matches neither form, so combo #0 keeps `verdict: "fail"` exactly like combos #2-#5, `report.pass`
stops depending on how many combos drew `asChild: true`, and `renderFailed` (`analyze.ts:3169`, keyed
on `renderHealth === "error"`, which this milestone never removes) still publishes
`providerCandidates` so the `ChakraProvider` hint prints.

## Open questions

None.

## Verification

**Unit.** `pnpm vitest run test/unit/transition-page-error-attribution.test.ts` — 15 passed.
`test/unit/harness-fault.test.ts` (16) and `test/unit/harness-fault-harden.test.ts` (10) pass
unchanged: every contract-branch fixture there uses "failed to slot onto its children", which the
mechanism form matches case-insensitively. `pnpm lint` (tsc --noEmit) clean.

**Real repo — D1, radix Label, unbounded zero-config run.**

```
cd /e/repositories/radix-primitives && node /c/Projekte/120fps/dist/cli.js \
  packages/react/label/src/label.tsx --json .../fix-c-radix-label.json     # EXIT=0, 4m
```

Console rows (`logs/fix-c-radix-label.log:22-29`), verbatim:

```
0    6.29ms  6.78ms  1.06ms  0  0  -  WARN (T1) [render error] [harness fault: asChild] [→ #1: 1 page error]
1    5.20ms  3.64ms  0.92ms  1  0  -  WARN (T1) [→ #2: 1 page error]
3    5.18ms  3.98ms  1.06ms  1  0  -  WARN (T1)
6    4.92ms  3.29ms  0.78ms  1  0  -  PASS (T1) [→ #7: 1 page error]
```

Combos #1 and #6 carry no `asChild` at all and previously printed a bare `[1 page error]` for an
error only a truthy `asChild` can raise. They now carry no own page errors (`combos[1].pageErrors`
absent in JSON) and a transition tag naming the successor whose props were being rendered. #3, whose
successor's `asChild` is falsy, has no errors of either kind — the predecessor-leak hypothesis V1
refuted stays refuted. The detail block reads:

```
  Combo #0:
    - Primitive.label failed to slot onto its children. ... `Slottable`. (×12)
    - Primitive.label failed to slot onto its children. ... `Slottable`. (×23)
    raised while transitioning to combo #1's props (excluded from combo 0's verdict):
      - Primitive.label failed to slot onto its children. ... `Slottable`. (×10)
```

**Real repo — D2, chakra tabs, bounded run.**

```
cd /e/repositories/chakra-ui && node /c/Projekte/120fps/dist/cli.js \
  packages/react/src/components/tabs/tabs.ts --samples 3 --max-combos 2 --explore-budget 30 \
  --json .../fix-c-chakra-tabs.json                                        # EXIT=1
```

```
0    8.29ms  6.64ms  1.04ms  0  0  -  FAIL (T1) [render error] [→ #1: 1 page error]
1    5.72ms  4.04ms  1.19ms  0  0  -  FAIL (T1) [render error]
```

`combos[0].props.asChild === true` and `harnessFault` is absent; every combo's verdict is `fail`,
matching the scale probes that never had `asChild` set. Before this milestone combo #0 was `warn`
with evidence `useContext returned undefined ... <ChakraProvider />` presented as proof that
`asChild` caused it. `report.pass === false`. The hint block prints the render-error remedy
(`a missing provider needs --wrap pointing at a setup module`).

Cleanup: `git status --porcelain` empty and no `.120fps-harness-*` / `120fps-report*.json` under
either repo after the runs.

**Observed, out of this milestone's contract.** chakra's run publishes no `providerCandidates`
(`report.providerCandidates` undefined), so the hint names `--wrap` without naming `ChakraProvider`:
`detectLocalProviderModule` / `detectProviderImport` (`src/preflight.ts`, Lane A) do not match
chakra's `create-context.ts` shape. Recorded as an interface observation, not a M99 defect — this
milestone's MUST is that the pipeline runs, which it now does.
