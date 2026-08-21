---
kind: milestone
status: draft
tests:
  - test/unit/explain-props-parity.test.ts
  - test/unit/rsc-one-hop-composition.test.ts
  - test/unit/matrix-disclosure-parity.test.ts
---

# M91: Modes and flags disclose identically

## Purpose

`--explain-props` is the tool's own cheapest and most-recommended first probe, and it is the mode
that hides the warning that matters most: preact-app's full run discloses that `next.config.js`
aliases `react-dom` to `preact/compat` for a build target 120fps cannot evaluate — "this measurement
runs the real react-dom, not what your app ships" — and the dry run says nothing, because
`assertReactDomClient` throws before `explainProps` ever reaches the code that would compute that
warning. Matrix mode has the analogous gap for `disclosureReason`: primevue's props-excluded mark and
reason show up on every combo-mode row and JSON entry, and vanish from the identical matrix cell.
commerce's `app/page.tsx` shows the same asymmetry in the opposite direction: a sync component whose
JSX composes two async Server Components one hop away passes `--explain-props` clean and then dies
with an obscure `__dirname is not defined`, because the import-graph walk only asks "is the *target*
async," never "does the target's JSX render something that is."

Closes: preact-app-F2, primevue-F2, commerce-F3, mantine-F4, element-plus-F3.

## Contract

### MUST

- `--explain-props` emits every pre-build warning the full run would emit for the same component:
  the framework/CSS/wrapper resolution warnings, preflight's soft (node-builtin) hits, and the
  bundler `react-dom` → `preact/compat` alias note — everything decidable without a browser, in the
  same order the full run computes it.
- Matrix mode carries the `[props excluded]` mark and `disclosureReason` in both its cell table and
  its JSON, as combo mode already does.
- The server-boundary import walk follows JSX composition at least one hop, so a sync component
  composing async server components is gated. commerce's `app/page.tsx` passes `--explain-props`
  clean and then dies with an obscure `__dirname is not defined`, while targeting the same async
  children directly produces a correct rejection.

### MUST NOT

- Let a dry run report a clean result where the real run refuses, or the reverse.

### Invariants

- A preflight hard rejection found through one-hop composition reads exactly as it would if the user
  had targeted that child file directly, with the original target's path prepended to the chain
  (`app/page.tsx → components/carousel.tsx`, not just `components/carousel.tsx`).
- `runPreflight` (`src/preflight.ts`, Lane A) is called, never edited: the one-hop reach is built by
  calling it an additional time per JSX-composed local import, entries[0] set to the child, exactly
  mirroring what a direct `120fps ./child.tsx` invocation already does correctly.

## Design

### `--explain-props` parity (`src/analyze.ts::explainProps`)

Before this milestone, `explainProps` computes only: preflight hard-rejection, the bundler-alias
note (but only if `assertReactDomClient` does not throw first — see below), prop-extraction
diagnostics, the preset-unknown note, and the zero-props note. It never resolves CSS, framework, or
wrapper, and never surfaces a preflight *soft* hit.

`explainProps` gains, in the same order `analyze()`'s full run computes them and before the
react-dom version gate:

1. `resolveFramework("auto", projectRoot, resolvedPath, onWarning)`
2. `resolveCssFiles({}, projectRoot, warnings)`
3. `resolveWrapPath({}, projectRoot, framework, warnings)`
4. `preflight.soft` hits → `NODE_BUILTIN_WARNING(hit)`, pushed alongside the existing hard-hit
   handling.

All three resolvers are read-only filesystem probes (existing detection functions, already used by
the full run) with no build/browser cost, so the function's own "no side effect" contract (no harness
directory, no dev server, no browser) is unaffected.

The `assertReactDomClient` vs. bundler-alias ordering bug (preact-app-F2's exact mechanism) is fixed
directly: `detectBundlerReactDomAlias` is checked and its warning pushed **before**
`assertReactDomClient` is called, and the call is wrapped so a version-gate throw still carries every
warning collected so far:

```ts
if (rendererFor(resolvedPath) === "react") {
  const bundlerAlias = detectBundlerReactDomAlias(projectRoot);
  if (bundlerAlias) warnings.push(BUNDLER_PREACT_ALIAS_WARNING(bundlerAlias.configFile, bundlerAlias.target));
  try {
    assertReactDomClient(projectRoot);
  } catch (err) {
    if (err instanceof Error) throw new Error(err.message + formatAccumulatedWarnings(warnings), { cause: err });
    throw err;
  }
}
```

`formatAccumulatedWarnings` is M90's newly module-level function, reused verbatim. The preflight
hard-rejection throw is unchanged (no accumulated warnings stacked on it), matching the full run's own
`PreflightHardRejectionError` treatment.

### Matrix mode `disclosureReason` parity (`src/report.ts`)

`MatrixCell` gains `disclosureReason?: "uncomposed" | "propsExcluded"`, populated in
`buildMatrixReport` from the combo each cell projects (`combos[cell.comboIndex].disclosureReason`) —
the same source combo-mode already reads, just copied across instead of left combo-only.
`formatMatrixOutput`'s cell-row renderer calls the same mark-formatting `renderHealthMarks` already
uses for combo mode, so a `[props excluded]`/`[uncomposed]` cell reads identically in both modes.

### RSC one-hop composition (`src/composition.ts`, `src/analyze.ts`)

`scanJsxComposedLocalImports(sourceText, fileName)` (new, `src/composition.ts`): walks a file's
top-level relative value imports (not type-only — mirrors `scanRelativeTypeImports`'s structure but
for the opposite import kind), then walks the file's JSX for opening/self-closing elements whose tag
name matches one of those imports. Returns `{ name, specifier }` for every local import actually used
as a JSX tag — the same "declared vs. actually composed" distinction `declaredCompositionSiblings`
already draws for sibling parts, applied to child components instead.

`composedChildPreflightHits(targetFile, projectRoot)` (new, `src/analyze.ts`): resolves each
JSX-composed specifier to a file (simple extension-probe resolution: `.tsx`/`.ts`/`.jsx`/`.js`, plain
and `/index.*`), and for each resolved child, calls the **unmodified** `runPreflight` again with
`entries: [child]` and `componentName` from `detectComponentExport(child)` — reproducing exactly the
rejection a direct `120fps ./child.tsx` invocation already produces correctly (per the map's own
framing: "the gate logic is right and only its reach is wrong"). Each hard hit's `chain` is prefixed
with the original target's relative path before merging into the primary preflight result, so the
message reads as a real composition chain rather than restarting at the child.

Called from both of `explainProps`'s and the full run's `runPreflight` call sites, immediately after
the primary call, folding `composedChildPreflightHits(...).hard` into `preflight.hard` before the
existing hard/soft handling runs unchanged — this is what gives `--explain-props` and the full run
identical RSC coverage for free, satisfying the parity MUST at the same time as the reach MUST.

## Open questions

None.

## Verification

- Fixture project: `react-dom` aliased to `preact/compat` in `next.config.js`, real installed
  `react-dom` below version 18. `--explain-props` and the full run produce the identical warning set
  (the alias note present in both) before either refuses on the version gate.
- Fixture project: a component whose Options-API-equivalent props are excluded by ADR 0002 (or an
  `uncomposed` sibling case), measured with `--matrix`: the cell table shows the mark and the JSON
  cell carries `disclosureReason`, matching the combo-mode JSON for the same underlying combo.
- Fixture project: a sync component (`page.tsx`) whose JSX renders two locally-imported async
  function components one hop away. `--explain-props` and the full run both refuse, chain reads
  `page.tsx → <child>.tsx`, message identical in shape to targeting the child directly.
- Negative: a sync component whose JSX composes a **non-async** local component one hop away is
  unaffected (no rejection, no change in output).
- Negative: `--explain-props` on a component with no risky import at all produces the same (empty)
  warning set as before this milestone.
