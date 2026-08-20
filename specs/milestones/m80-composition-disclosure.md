---
kind: milestone
status: draft
tests:
  - test/unit/composition.test.ts
  - test/unit/composition-report.test.ts
  - test/unit/composition-rollback.test.ts
  - test/unit/render-health.test.ts
  - test/unit/prop-gen.test.ts
  - test/unit/vue-support.test.ts
---

# M80: composition disclosure

## Goal

A report never presents a confident verdict for a component that was not actually assembled.
Two repositories converge on the same defect through different code paths: radix-primitives'
`Tabs`/`Accordion`/`ScrollArea`/`Select` mount their bare `Root` export with none of their
declared sibling parts, and PrimeVue's `DataTable` mounts with 0 of ~69 real props read. Both
runs complete, print real timings, and say `Result: PASS`. Closes `radix-primitives-F1` (P1),
`base-ui-F1` (P1), and the disclosure half of `primevue-F1` (P1) — extraction itself is correct
per ADR 0002; only the silence around it is the defect.

## Correction: base-ui's file shape is not what the finding narrative implies

`base-ui.md` F1 describes the mechanism as "compound Root components never compose the sibling
parts declared in the same file." Read directly, this is true for radix and false for base-ui.
`packages/react/src/tabs/root/TabsRoot.tsx` (`E:\repositories\base-ui`) exports exactly one
component, `TabsRoot` (`TabsRoot.tsx:26`), plus types; `TabsList`, `TabsTab`, `TabsPanel`, and
`TabsIndicator` live in sibling directories (`tabs/list/`, `tabs/tab/`, `tabs/panel/`,
`tabs/indicator/`) and are aggregated only by the package barrel
(`tabs/index.ts:1`, `export * as Tabs from './index.parts'`), which the field test never measured.
A same-file-export check, as radix needs, would find zero candidates here and never fire.

What `TabsRoot.tsx` *does* declare, in itself, are two type-only relative imports:
`import type { TabsTab } from '../tab/TabsTab';` and `import type { TabsPanel } from
'../panel/TabsPanel';` (`TabsRoot.tsx:12-13`). Scope 1 below treats a same-file export and a
same-file type-only relative import as the same kind of evidence — both are things the measured
file itself declares, and both are exactly the data auto-composition (M17) already reads or could
read without opening a second file. This is the one place this spec extends what M17's own
`findRoot`/`classifySuffix` inspect; scope 1 states precisely why, and "Does NOT include" states
precisely what is still left uncaught (`TabsIndicator`, `TabsList` — never imported, even for
their types, by `TabsRoot.tsx`).

## Root cause, verified independently of the finding's own explanation

The finding's stated mechanism ("disclosure fires only when `domNodeCount` is exactly 0") is a
real and correctly-observed symptom, confirmed at `src/analyze.ts:477`:

```ts
if (combo.domNodeCount === 0) {
  combo.renderHealth = pageErrors?.fatal ? "error" : "empty";
}
```

But for radix, `domNodeCount` never even gets the chance to be the deciding factor, because
auto-composition (M17) never runs. `packages/react/tabs/src/tabs.tsx:299-311` exports both the
prefixed family (`Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`) **and** bare Radix-convention
aliases of the same values (`Tabs as Root`, `TabsList as List`, `TabsTrigger as Trigger`,
`TabsContent as Content`) — nine PascalCase exports total (`createTabsScope` is filtered by
`isComponentName`, `src/prop-gen.ts:1690-1694`). `findRoot` (`src/composition.ts:70-88`) requires
a candidate name to be a prefix of *every other* export: `"Tabs"` fails because `"Root"` does not
start with `"tabs"`; `"Root"` fails because `"List"` does not start with `"root"`; every candidate
fails the same way, `candidates.length === 0`, and `inferComposition` returns `null`
(`src/composition.ts:114`) with no warning. `select.tsx:1931-1971` and `accordion.tsx:547-561`
declare the same dual-family shape (verified directly); `scroll-area.tsx` is assumed to match by
the same repo-wide convention but was not independently re-read. The tool then falls back to
mounting whichever single export `detectComponentExport` binds by stem match
(`src/harness.ts:2265-2304` — `Tabs` for `tabs.tsx`, matching `radix-primitives.md` F3's observed
`binding:` line), synthesizes its props normally, and — because `TabsRoot`-equivalent components
self-render one wrapper `<div>` — lands on `domNodeCount === 1`, which is nonzero, so line 477
never fires.

A second, independent bug compounds this if `findRoot` is ever fixed later (not in this
milestone): `classifySuffix` (`src/composition.ts:61-68`) computes
`name.slice(rootName.length)`, a fixed-length slice, not an actual prefix check. For a bare alias
shorter than the root name (`classifySuffix("List", "Tabs")` → `"List".slice(4)` → `""` →
`"unknown"`), this silently misclassifies every bare alias regardless of whether `findRoot`
succeeded. Scope 1's new stem function does not reuse or fix `classifySuffix`; it is new,
disclosure-only code, so `inferComposition`'s existing behavior and `test/unit/composition.test.ts`
are untouched by this milestone.

## Scope

### 1. The composition-gap signal (`src/composition.ts`, `src/prop-gen.ts`, `src/analyze.ts`)

Replaces "check `domNodeCount === 0`" with a signal computed from what the file itself declares,
independent of what got measured:

```ts
// src/composition.ts
export interface DeclaredSibling {
  name: string;
  role: SuffixRole; // reuses the existing SuffixRole union and SUFFIX_MAP
}

// Stems by longest common case-insensitive prefix instead of classifySuffix's
// fixed-length slice, so it classifies correctly whether the candidate shares
// a literal prefix with the resolved root (TabsList vs Tabs), shares none at
// all (the bare alias List vs Tabs), or the root itself carries a suffix the
// candidate does not (TabsPanel vs TabsRoot, stem "Tabs"). Disclosure-only:
// inferComposition and classifySuffix are not called from here and are not
// changed.
function classifyByStem(name: string, rootName: string): SuffixRole { /* LCP, then SUFFIX_MAP */ }

// Fires precisely when: composition was not applied for this run, and the
// file's own exports or same-file type-only relative imports still name at
// least one part the existing SUFFIX_MAP taxonomy recognizes. Deduplicated by
// role, not by name, so radix's prefixed/bare alias pairs (TabsList and List)
// count once.
export function declaredCompositionSiblings(
  rootName: string,
  siblingExports: ExportInfo[],   // same-file exports, resolved root excluded
  typeImportNames: string[],      // same-file relative type-only imports
): DeclaredSibling[]

export const UNCOMPOSED_SIBLINGS_WARNING = (root: string, siblings: string[]): string =>
  `${root} declares sibling parts (${siblings.join(", ")}) recognized by auto-composition, but ` +
  `none were composed in: every combo measured the bare ${root} export alone. Try --init-fixture ` +
  `to scaffold a fixture, or compose them yourself and pass --fixture.`;
```

New AST scan, sibling of `scanExports` (`src/prop-gen.ts:1455`), reading the one file already
open for export extraction — no directory walk:

```ts
// src/prop-gen.ts
export function scanRelativeTypeImports(sourceText: string, fileName: string): string[]
export async function extractRelativeTypeImports(filePath: string): Promise<string[]>
```

Collects the local name of every `import type { X }` or `import { type X }` specifier whose
module specifier starts with `.`. `TabsRoot.tsx:12-13` yields `["TabsTab", "TabsPanel"]`.

Wiring in `src/analyze.ts`, inside the existing composition guard (`:2000`,
`!fixturePath && !inputIsFixture && !options.skipAutoCompose && !rendererIsVue && !options.target`
— an explicit fixture, target, or `--no-auto-compose` already means the user is in control, so the
new check is silent there too, matching M17's own scope):

- After the existing `if (componentExports.length > 1) { … }` block (`:2002-2006`), when
  `compositionTree` is still `undefined`: resolve `detectComponentExport(resolvedPath,
  options.target).name` (the same binding `--explain-props` already discloses, per
  `radix-primitives.md` F3), call `extractRelativeTypeImports(resolvedPath)`, and call
  `declaredCompositionSiblings`. A nonempty result sets a local `disclosureReason: "uncomposed"`
  and builds the warning text; both are held locally because `runWarnings` (`:2042`) is not
  declared yet at this point in the function and is seeded with this warning when it is declared.
- Inside the trial-mount rollback branch (`:2284-2300`), *before* `compositionTree = undefined;`
  and `componentExports = undefined;` clear the values the check needs: run the same check using
  `compositionTree!.root` and the not-yet-cleared `componentExports`, and push the warning to the
  already-declared `runWarnings` directly. `COMPOSITION_EMPTY_WARNING` (existing) and
  `UNCOMPOSED_SIBLINGS_WARNING` (new) can both appear on the same run — they state different
  things (a structural guess mounted empty; specific recognized parts never appeared either way)
  — and DialogRoot's own combos are untouched by this addition (see below).

`BuildReportInput` (`src/analyze.ts:358`) gains `disclosureReason?: "uncomposed" | "propsExcluded"`
(the second value belongs to scope 2). `buildReport` (`:380`) applies it once, after the per-combo
loop, next to the existing `if (input.compositionTree) { report.compositionTree = … }` block
(`:573-575`):

```ts
if (input.disclosureReason) {
  for (const combo of combos) {
    // renderHealth ("error"/"empty") already fully discloses this combo —
    // DialogRoot's honest zero-DOM case is untouched, per requirement below.
    if (combo.renderHealth) continue;
    combo.disclosureReason = input.disclosureReason;
    if (combo.verdict === "pass") combo.verdict = "warn";
  }
}
```

**Preserving the honest DialogRoot case**: `combo.renderHealth` is computed first, at line 477,
inside the same per-combo loop this block runs after. A combo with `domNodeCount === 0` already
has `renderHealth` set to `"error"` or `"empty"` and is skipped by `if (combo.renderHealth)
continue;` above — its verdict and marks are exactly what they are today. Only a combo that
rendered *something* (the dangerous case this milestone targets — a real-looking DOM count with
none of the declared parts inside it) gets the new field and the downgrade.

### 2. PrimeVue's silent Options-API exclusion (`src/vue-sfc.ts`, `src/prop-gen.ts`)

Per ADR 0002:26 and the M76-M83 map's cross-cutting rule, the exclusion itself is correct and
out of scope to widen. The defect is that `extractVueProps` (`src/prop-gen.ts:406-434`) discards
the distinction between "this SFC has no props to speak of" and "this SFC declares props in a form
we don't read." `parseSfcScript` (`src/vue-sfc.ts:80-98`) only ever returns the `<script setup>`
block; when a `.vue` file has a plain `<script>` block instead (`descriptor.script`, already typed
at `src/vue-sfc.ts:23` but never read), that fact is dropped, and `extractVueProps` falls through
to `if (!root) return [];` (`src/prop-gen.ts:415`) with the same empty result either way.

New helper in `src/vue-sfc.ts`, called only when `descriptor.scriptSetup` is absent (never runs
on a normal `<script setup>` SFC, so no cost is added to the common path):

```ts
// Distinguishes "genuinely no props" from "props declared in a form ADR 0002
// excludes." Shallow: inspects only the top-level default-exported object
// literal's own property names (props / extends / mixins), not a full
// evaluation of the Options API object.
export function detectOptionsApiProps(
  source: string,
  filename: string,
  compiler: VueSfcCompiler,
): "props" | "extends" | "mixins" | undefined
```

A `<script>` block with none of the three property names is not flagged: it declares no props,
the same legitimate case as a leaf React component with an empty props type (`BaseButton.vue`'s
own honest `renderHealth: "empty"` in the field test is unaffected — that disclosure is about
`domNodeCount`, not props, and already works).

`extractVueProps` gains the same `sink` call other degenerate cases already use
(`warnDegenerateProps`, `:432`): when `detectOptionsApiProps` returns a form, call
`sink?.(VUE_OPTIONS_API_PROPS_WARNING(absolutePath, form))` before `return [];`.
`VUE_OPTIONS_API_PROPS_WARNING(path, form)` names the file and the form (`"props"`, `"extends"`,
or `"mixins"`) and states the ADR 0002 boundary in one sentence, matching
`ALIAS_SHAPE_WARNING`/`COMPOSITION_EMPTY_WARNING`'s existing style.

**Reaching the report**: `analyze.ts`'s `extractSchemas` closure (`:2056-2065`) currently calls
`extractProps(file, options.target ? { target: options.target } : undefined)` — `onWarning` is
never passed, so today this warning (and every other one `extractPropsDetailed` can produce
through `sink`) is silently dropped on the measurement path, even though `--explain-props`
(which does pass `onWarning`) would show it. This is a pre-existing gap this milestone closes as
a side effect: `extractSchemas` passes `onWarning` alongside `target`. When the resulting
`schemas.length === 0` for a Vue file and a `VUE_OPTIONS_API_PROPS_WARNING` was recorded, the
caller sets `disclosureReason: "propsExcluded"` on `BuildReportInput`, reusing the exact verdict
and per-combo wiring scope 1 built (`renderHealth`-aware skip, pass→warn downgrade,
`combo.disclosureReason`).

### 3. Verdict semantics: WARN, not PASS-with-a-footnote and not refusal

Three options were on the table:

- **Keep PASS, attach a disclosure.** Rejected. `report.pass` and `combo.verdict` are what
  CI consumers gate on; the whole defect class is that these runs already print correct-looking
  numbers next to `Result: PASS`. A disclosure that never touches the verdict is exactly the
  "confident numbers, print real numbers, run completes" failure mode this milestone exists to
  close — it would satisfy the JSON-field requirement in scope 1/2 but not the "never presents a
  confident verdict" goal stated at the top of this spec.
- **Refuse a verdict.** Rejected. A Root-only render still has real, legitimate uses (isolating a
  compound component's own wrapper cost from its children, exactly what the honest DialogRoot case
  already treats as a valid PASS/WARN today). Refusing outright would also contradict "Explicitly
  preserve the honest DialogRoot case," which currently completes with a verdict, and there is no
  precedent anywhere in the codebase for a combo with no verdict at all — `computeVerdict`
  (`src/report.ts:467`) always returns one of `"pass" | "warn" | "fail"`.
- **Downgrade to WARN.** Chosen. This matches M59's own precedent exactly: `renderHealth` sits
  "alongside the verdict as a reason, not an outcome" for the `"empty"` case (unconditional PASS
  survives), but `"error"` *does* force `"fail"` (`src/report.ts:475`) because an uncaught
  exception can never be trusted. The new case sits between these two, closer to `"empty"`: nothing
  crashed and the mount-cost numbers for what *did* render are real, so a hard FAIL would be a
  false alarm on legitimate uses. But unlike `"empty"` — which is maximally self-disclosing, a
  `domNodeCount` of zero cannot be mistaken for anything else — a nonzero `domNodeCount` next to a
  PASS is exactly the shape a reader trusts by default. WARN is the existing "still usable, actively
  flagged" bucket (`report.pass = combos.every(c => c.verdict !== "fail")`, `src/analyze.ts:537` —
  a WARN combo keeps `report.pass: true` at the top level, same as any other WARN today, but every
  consumer that reads `combo.verdict` sees it).

Scope: this downgrade runs inside `buildReport`, which both the combo and matrix report shapes
share (matrix cells are combos, per M21). Curve mode (`scalingCurveReport`) and isolation mode
compute their own pass/fail independently of `computeVerdict` and are not touched — the
underlying warning text and `combo.disclosureReason` still appear in those reports because
composition inference runs before mode branching (`:2000`, ahead of the mode dispatch), but their
mode-specific verdict fields are unaffected. Flagged explicitly under "Does NOT include," not
silently left inconsistent.

### 4. Both channels

- **JSON**: `ComboReport.disclosureReason?: "uncomposed" | "propsExcluded"` (`src/report.ts:166`,
  next to `renderHealth`), present on every combo the run-level condition applies to and that did
  not already get a `renderHealth` value, absent otherwise. `report.warnings` (existing field,
  already `JSON.stringify`'d verbatim per `src/analyze.ts:864`) carries the human-readable
  `UNCOMPOSED_SIBLINGS_WARNING` / `VUE_OPTIONS_API_PROPS_WARNING` text, same mechanism as every
  other named warning in the codebase (`ALIAS_SHAPE_WARNING`, `COMPOSITION_EMPTY_WARNING`,
  `BROKEN_ALIAS_WARNING`). A CI consumer checks `combo.disclosureReason` for a stable enum, or
  greps `report.warnings` for the human text; both are populated by the same computation, so they
  cannot drift apart.
- **Console**: no new printer function. `appendWarnings` (`src/report.ts:777-781`) already prints
  every `report.warnings` entry prefixed with `⚠`; pushing the new warning strings there is
  sufficient. `renderHealthMarks` (`src/report.ts:733-742`) gains two more cases so the verdict
  cell itself carries the mark, not just a warning line further down the output:
  `combo.disclosureReason === "uncomposed"` → `" [uncomposed]"`;
  `"propsExcluded"` → `" [props excluded]"`. This mirrors the existing `" [no DOM]"` /
  `" [render error]"` marks exactly and needs no new function.

## Changed contracts

- `ComboReport` gains `disclosureReason?: "uncomposed" | "propsExcluded"`. Absent on every
  existing report shape (composition succeeded, or no known-excluded prop form was hit) — no
  existing fixture or snapshot changes.
- `combo.verdict` can now become `"warn"` for a combo that previously computed `"pass"` under two
  new, narrow conditions (declared-but-uncomposed siblings; Options-API prop exclusion), and only
  when `combo.renderHealth` is absent. No existing `"fail"` combo can be affected (the downgrade
  never touches a `"fail"` verdict), and no combo gains a new `"fail"`.
- `extractSchemas` (`src/analyze.ts:2056`) now passes `onWarning`, so any warning
  `extractPropsDetailed` already knew how to produce (not just the new Vue one) reaches
  `report.warnings` on the measurement path for the first time. This is a corollary of closing the
  plumbing gap, not a new warning source; existing warning-shape tests are unaffected because no
  currently-measured project trips one of `extractPropsDetailed`'s other `sink` calls without also
  already showing up via `--explain-props`.

## Does NOT include

- Fixing `findRoot`'s prefix-matching failure on radix's dual prefixed/bare-alias export shape, or
  `classifySuffix`'s fixed-length-slice bug (`src/composition.ts:62`). Both are real, verified
  defects in M17's own inference, not in this milestone's disclosure. Fixing either would compose
  radix's four candidates for real, which is explicitly out of scope: "this milestone makes the gap
  visible, it does not close it" (M76-M83-MAP).
- Composing `TabsList`/`TabsIndicator` for base-ui, or any cross-file sibling discovery beyond a
  same-file relative type-only import. `TabsRoot.tsx` never imports `TabsList` or `TabsIndicator`
  even for their types, so this milestone's signal does not name them; only `TabsTab`/`TabsPanel`
  (via the `Panel` role) surface. Reading the package barrel (`tabs/index.ts`) to find the rest
  would be a real capability improvement, not a disclosure fix, and needs its own milestone.
- Prop synthesis or value selection (M81's ownership per the map) — this milestone only changes
  whether a gap is disclosed and how hard the verdict falls, never what value gets passed for a
  prop.
- Stylesheet disclosure (M82) and flag-parity/report self-consistency (M83) — separately scoped.
- Widening ADR 0002's TypeScript-only scope to actually read Options API `props: {}` or
  `defineProps({...})`. That is a product decision needing its own ADR, not a milestone fix,
  per the M76-M83 map's cross-cutting rule.
- A new `HintId` in `src/hints.ts`. The remedy (`--init-fixture`, `<stem>.props.tsx`) is stated
  inline in the warning text itself, matching `COMPOSITION_EMPTY_WARNING`'s existing style; adding
  a fourth file's contract change for the same information was judged unnecessary indirection.
- Verdict downgrade for curve mode and isolation mode (see scope 3) — their own pass/fail
  computation is untouched; only the combo/matrix path gets the WARN downgrade.
- Re-verifying `scroll-area.tsx`'s export shape directly (assumed identical to the other three
  radix files verified in "Root cause" above, per the field test's own repo-wide observation).

## Acceptance

- A same-file compound Root exporting both a prefixed sibling family and bare Radix-convention
  aliases (radix's `tabs.tsx`/`accordion.tsx`/`select.tsx` shape, reproduced as a fixture export
  list) that renders exactly one wrapper element: `declaredCompositionSiblings` returns a nonempty,
  role-deduplicated list; the run's `combo.disclosureReason` is `"uncomposed"` on every combo that
  has no `renderHealth`; a `"pass"` verdict becomes `"warn"`; `report.warnings` contains
  `UNCOMPOSED_SIBLINGS_WARNING`'s text naming the root and its siblings and pointing at
  `--init-fixture`.
- A Root that renders nothing (DialogRoot's shape: `domNodeCount === 0` on every combo): every
  existing `renderHealth: "empty"` / `"Result: PASS"` / `appendEmptyRenderNote` behavior is
  unchanged, byte-for-byte, in both console and JSON. No combo gains `disclosureReason`.
- A single-part leaf component with no recognized sibling parts (radix's `separator.tsx`:
  `Separator`/`Root` only, `Root` classifies as `"unknown"` under the new stem function exactly as
  it does under `classifySuffix` today): `declaredCompositionSiblings` returns `[]`; no warning; no
  verdict change; the control case stays green.
- A Vue SFC with a plain `<script>` block whose default export is a Options-API `props: {...}`
  object literal (`BaseButton.vue`'s shape) or `extends: BaseX` (`Button.vue`/`DataTable.vue`'s
  shape): `detectOptionsApiProps` returns `"props"` or `"extends"`; `extractSchemas` records
  `VUE_OPTIONS_API_PROPS_WARNING` naming the file and the form; `disclosureReason: "propsExcluded"`
  applies the same pass→warn downgrade as the composition case; a Vue SFC with a `<script>` block
  that declares neither `props`, `extends`, nor `mixins` (a genuinely propless component) triggers
  neither the warning nor the downgrade.
- A file whose composition *did* succeed (an existing passing fixture, e.g. any
  `test/unit/composition.test.ts` case that already builds a non-null `CompositionTree`) gets no
  `disclosureReason` and no verdict change — this milestone adds a new negative case, it does not
  touch the positive path.
