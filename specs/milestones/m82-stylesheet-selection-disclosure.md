---
kind: milestone
status: draft
tests:
  - test/unit/global-stylesheet-fallbacks.test.ts
  - test/unit/entry-stylesheet-discovery.test.ts
  - test/unit/style-engine-detection.test.ts
  - test/unit/runtime-style-engine-detection.test.ts
  - test/unit/stylesheet-candidate-validation.test.ts
  - test/unit/stylesheet-selection-report.test.ts
---

# M82: stylesheet selection is validated and disclosed

## Goal

The stylesheet the harness injects is one the application would actually load, and the report
always says which stylesheet was used and why — including when the answer is none. M71 built a
four-layer discovery chain (`src/harness.ts:578` `discoverGlobalCss`: entry imports, known names,
largest-stylesheet fallback) and claimed "each layer validated and disclosed." The validation half
is real for layers 1-3 (`entryStylesheetImports`, `validateCssFiles`); the fallback layer
(`largestStylesheet`, `src/harness.ts:532`) validates only that the winning file exists — it never
asks whether the file is one the project would plausibly load, and the disclosure half is silent
whenever nothing was found at all: `report.css` is only constructed when
`resolvedCss.files.length > 0` (`src/analyze.ts:2026`), and `formatTable`'s `Stylesheets:` line
only prints under the same condition (`src/report.ts:529`). A `largest of n=1` fallback pick reads
as a confidence signal when it is not — heroui's winning "largest" stylesheet was the *only* `.css`
file anywhere under the scanned package.

Two field-test repositories were confirmed to inject a stylesheet the application never loads
(ant-design, cal.com), with zero disclosure in either case. Three more repositories had real,
reachable-in-principle CSS that discovery never mentioned finding or not finding (element-plus,
radix-primitives, base-ui) — the JSON report has no `css` key at all. One repository, chakra-ui,
got the outcome right (no static stylesheet exists; none was injected) but said nothing, which is
indistinguishable from the detector never having run. This milestone makes the fallback layer
distrust itself before it fires, and makes every run say what it decided, including "none."

## Closes

- `ant-design-F2` (P1) — the repo's only `.css` file, an opt-in-only reset nothing imports, was
  wired into every harness entry with zero disclosure.
- `calcom-F2` (P1) — an unrelated component's CSS was injected in place of the unreachable real
  Tailwind entry, with zero disclosure.
- `heroui-F3` — a 67-byte `@import`-only placeholder was picked as "the largest stylesheet" because
  it was the only one, with no signal that "largest" meant nothing here.
- `element-plus-F5`, `radix-primitives-F4`, `base-ui-F5` — discovery ran and found nothing, and
  said nothing: no stdout line, no `css` key in the JSON.

**Preserves:** `chakra-ui-F9` — discovery correctly stayed silent for Chakra's Emotion-only
styling. This milestone keeps that outcome and adds the positive statement it was missing: the run
now says styling is runtime and no stylesheet was needed, rather than saying nothing.

## Scope

### Principle: validation applies only to the layer that guesses

Layers 1-3 (`--css`, entry imports, known filenames) are each backed by evidence — a user's
explicit choice, a real import statement, or a conventional path that exists. The checks below
apply **only** to the largest-stylesheet fallback (layer 4), which is backed by nothing but file
size. An entry that imports an empty stylesheet, or a known-name candidate that happens to be
small, is left untouched: the project's own toolchain would load it too, and second-guessing
evidence-backed picks is out of scope.

### Fallback candidate validation (`src/harness.ts`)

Two checks disqualify a fallback candidate before it can be injected. Both are text-only (no CSS
parser, no execution), matching the "text only" invariant M71 already established for
`readViteConfigData` (`m71-css-discovery-and-vite-config-data.md`):

- **Unbuilt placeholder**: `stylesheetRuleCount(file): number` strips `/* ... */` comments and
  `@import`/`@charset`/`@use` at-rule statements (each through its terminating `;`), then counts
  the remaining `{` occurrences. Zero means the file's entire content is a passthrough import —
  nothing was ever built into it (heroui's `styles.css`: `@import "@heroui/styles";`, rule count
  0). Files above 2MB skip the read and are treated as plausible (a file that large is not an
  unbuilt placeholder; reading it is not worth the cost this early in the pipeline).
- **Opt-in reset**: `isOptInResetName(file): boolean` matches the file's extension-stripped
  basename, case-insensitively, against `RESET_STYLESHEET_STEMS = ["reset", "normalize",
  "preflight", "sanitize"]`. A file named this way is a reset/normalize library's own convention —
  intentionally opt-in everywhere it appears (ant-design's `components/style/reset.css`, real
  rules, rule count > 0, still disqualified by name). This check does not require the file to be
  unreferenced by anything the harness can see; the name alone is the signal, because a project
  that *does* import its reset deliberately reaches it through layer 2 (entry imports) and never
  falls to layer 4 at all.

`rankedStylesheets(projectRoot: string): Array<{ file: string; size: number }>` generalizes
`largestStylesheet`'s walk (same skip-dirs, same depth/entry caps, same CSS-module exclusion) to
return every candidate sorted descending by size, tying on path — `rankedStylesheets(root)[0]?.file
=== largestStylesheet(root)`. `largestStylesheet` keeps its exact current signature and behavior
unchanged; other callers of the raw "biggest stylesheet" answer are unaffected.

The fallback layer walks `rankedStylesheets` in order, skipping and warning on each disqualified
candidate (`CSS_PLACEHOLDER_SKIPPED_WARNING`, `CSS_RESET_SKIPPED_WARNING`, both new, `(relative:
string) => string`), and injects the first survivor. Skipping candidates is intentionally scoped to
the current scan root (`projectRoot`, unchanged): widening the scan to sibling workspace packages
or the workspace root is a discovery-scope change, not a validation change, and is explicitly out
of scope (see Does NOT include).

### Runtime CSS-in-JS is a first-class outcome (`src/harness.ts`)

```ts
export const RUNTIME_STYLE_ENGINES = [
  "@ant-design/cssinjs",
  "@emotion/react",
  "@emotion/styled",
  "@emotion/css",
  "styled-components",
  "primevue",
];

export function detectRuntimeStyleEngines(
  projectRoot: string,
  workspaceRoot: string = findWorkspaceRoot(projectRoot),
): string[] {
  return RUNTIME_STYLE_ENGINES.filter((pkg) => isPackageAvailable(pkg, projectRoot, workspaceRoot));
}
```

Same detection pattern as M71's `detectUnsupportedStyleEngines` (`src/harness.ts:663`, declared or
installed via `isPackageAvailable`, `src/project-model.ts:165`) but the opposite meaning:
`UNSUPPORTED_STYLE_ENGINES` says styling exists and cannot be replicated (a warning, fidelity is
degraded); `RUNTIME_STYLE_ENGINES` says styling is generated live in the browser and no static file
was ever going to exist (informational, fidelity is not degraded — this *is* how the app styles
itself). The two lists are checked independently and both may fire in principle; they are not
mutually exclusive.

This check runs **only when the fallback layer's ranked-candidate walk has no survivor** (every
candidate was disqualified, or none existed at all) — never before layers 1-3 are tried, and never
as a reason to skip a real find. A project can legitimately mix Tailwind (layer 1/2/3, reachable)
with Emotion for components; a real, reachable stylesheet still wins normally. Checking runtime
engines only at the point where the fallback has nothing left to offer is what makes ant-design
(fallback candidate disqualified by name, then `@ant-design/cssinjs` found) and chakra-ui (no
candidates at all, then `@emotion/react`/`@emotion/styled` found) resolve correctly without
touching the cases where a real file exists.

### `CssDiscovery` and `discoverGlobalCss` (`src/harness.ts:570`)

```ts
export interface CssDiscovery {
  files: string[];
  source: "entry" | "candidate" | "fallback" | "runtime" | "none";
  // present only when source === "fallback"
  onlyCandidate?: boolean;       // rankedStylesheets(projectRoot) had exactly one entry
  noEntryInPackage?: boolean;    // findProjectEntry(projectRoot) found nothing at all
  // present only when source === "runtime"
  runtimeEngines?: string[];
}
```

`discoverGlobalCss`'s order is otherwise unchanged (entry, then candidate) up through where it
currently falls to `largestStylesheet`. That single call is replaced by the ranked-and-validated
walk above; when it yields nothing, `detectRuntimeStyleEngines` decides between `source: "runtime"`
and `source: "none"`.

`CSS_FALLBACK_WARNING`'s signature changes to carry the two new fallback-only signals:

```ts
export function CSS_FALLBACK_WARNING(
  relative: string,
  opts: { onlyCandidate: boolean; noEntryInPackage: boolean },
): string {
  const scope = opts.onlyCandidate
    ? "the only stylesheet found under this project"
    : "the largest stylesheet found under this project";
  const entryNote = opts.noEntryInPackage
    ? "; this package has no application entry (index.html or Next.js app/pages stem) of its " +
      "own, so the pick has no import evidence behind it at all"
    : "";
  return (
    `no entry stylesheet import and no conventional global stylesheet were found, so ${relative} ` +
    `was injected because it is ${scope}${entryNote}; pass --css to name the right one`
  );
}
```

This directly answers the "largest of n=1 is vacuous" complaint (heroui) with `onlyCandidate`, and
the "the real entry is unreachable from this package" complaint (cal.com, element-plus) with
`noEntryInPackage` — both computed from data `discoverGlobalCss` already has, no new resolution
logic. `noEntryInPackage` does not change what gets scanned or picked; it only names, honestly, why
the pick has no import evidence behind it — widening the scan to find the real file (a different
workspace package) is a discovery-scope change and out of scope here (see Does NOT include).

### `CssReport` always present (`src/report.ts:317`, `src/analyze.ts:2025`)

```ts
export interface CssReport {
  files: string[];              // unchanged: projectRoot-relative posix paths, injection order
  autoDetected: boolean;        // unchanged
  layer: "explicit" | "entry-chain" | "known-name" | "largest-fallback" | "runtime" | "disabled" | "none";
  details?: Array<{ file: string; bytes: number; rules: number }>; // one per file, same order
  runtimeEngines?: string[];    // present only when layer === "runtime"
  onlyCandidate?: boolean;      // present only when layer === "largest-fallback"
  noEntryInPackage?: boolean;   // present only when layer === "largest-fallback"
}
```

`layer` maps from `resolveCssFiles`'s outcome: `"explicit"` for a user-supplied `--css`,
`"disabled"` for `--no-css`, and `CssDiscovery.source` translated `entry → "entry-chain"`,
`candidate → "known-name"`, `fallback → "largest-fallback"`, `runtime → "runtime"`, `none →
"none"`. `resolveCssFiles` (`src/analyze.ts:2452`) returns this alongside `files`/`autoDetected`
so `analyzeComponent` (`src/analyze.ts:2025`) can build a `CssReport` **unconditionally** — the
`resolvedCss.files.length > 0` gate at `:2026` is removed, so `report.css` is always constructed,
never `undefined`, for every run this milestone touches. `details` is computed for every file in
`files` regardless of layer (including `"explicit"`), via `stylesheetRuleCount` and
`fs.statSync(file).size`, reusing the same two primitives the fallback validation already needed —
this is what makes a 67-byte placeholder distinguishable from a real stylesheet in the JSON even
when the user named it explicitly.

`Report.css` (`src/report.ts`) stays `css?: CssReport` in the type — optional for reading reports
and baselines written before this milestone, the same pattern M64 used for `mode?: ReportMode`
(`02-milestones.md` M64) — but every report this milestone produces populates it.

### Always-disclosed console line (`src/report.ts:529`)

The `report.css.files.length > 0` gate on the `Stylesheets:` line is removed; the line always
prints when `report.css` exists, with wording keyed on `layer`:

| `layer` | line |
|---|---|
| `explicit` | `Stylesheets: <files> (explicit --css)` |
| `entry-chain` | `Stylesheets: <files> (found in the project entry's own imports)` |
| `known-name` | `Stylesheets: <files> (matched a conventional filename)` |
| `largest-fallback` | `Stylesheets: <files> (largest-stylesheet fallback, low confidence — verify with --css)` |
| `runtime` | `Stylesheets: none — styling is generated at runtime by <runtimeEngines>; no stylesheet was needed` |
| `disabled` | `Stylesheets: none (--no-css)` |
| `none` | `Stylesheets: none found (checked the project entry, conventional filenames, and the largest stylesheet under the project)` |

The `runtime` and `none` rows are the two halves of "distinguish I found nothing from nothing was
needed": both print `none`, but only one claims styling is handled elsewhere. What was skipped
along the way (a disqualified fallback candidate, a preprocessor-missing entry import, an
unresolved specifier) continues to travel through the existing `report.warnings` channel
(`CSS_PLACEHOLDER_SKIPPED_WARNING`, `CSS_RESET_SKIPPED_WARNING`, `CSS_IMPORT_SKIPPED_WARNING`,
`CSS_PREPROCESSOR_MISSING_WARNING`, all pre-existing or defined above) — the `Stylesheets:` line
states the outcome, the warnings state what was rejected and why.

### Baseline fingerprint identity is preserved (`src/analyze.ts:846`, `:1559`, `:1887`)

Three `buildEnvFingerprint` call sites gate a `css` fingerprint key on `ctx.cssReport`/
`args.cssReport` being truthy: `...(ctx.cssReport ? { css: ctx.cssReport.files } : {})`. Before
this milestone that was equivalent to "files is non-empty," because `cssReport` itself was
`undefined` whenever discovery found nothing. After this milestone `cssReport` is **always**
constructed, so an unguarded truthy check would start including `css: []` in the fingerprint for
every project that previously omitted the key — silently invalidating every cached M39 baseline
for a no-CSS project and every M45 per-environment slot keyed against it. All three sites change
to `...(ctx.cssReport && ctx.cssReport.files.length > 0 ? { css: ctx.cssReport.files } : {})`,
restoring the exact prior fingerprint bytes for the no-CSS case. This is a fingerprint-identity
fix, not a new feature, and ships with this milestone because the `cssReport`-is-always-present
change is what creates the risk.

## Changed contracts

- `CssDiscovery.source` gains `"runtime"` alongside the existing `"entry" | "candidate" |
  "fallback" | "none"`, and gains the optional `onlyCandidate`/`noEntryInPackage`/`runtimeEngines`
  fields described above.
- `CSS_FALLBACK_WARNING`'s signature changes from `(relative: string)` to `(relative: string, opts:
  { onlyCandidate: boolean; noEntryInPackage: boolean })`. `test/unit/global-stylesheet-fallbacks
  .test.ts:117-122` and `:159-164` construct a single-file, no-entry tmpdir fixture, so both
  updated assertions pass `{ onlyCandidate: true, noEntryInPackage: true }`.
- `CssReport` gains `layer` (always present), `details`, `runtimeEngines`, `onlyCandidate`,
  `noEntryInPackage`. `files` and `autoDetected` keep their exact current shape and meaning.
- `report.css` is no longer omitted when nothing was found; every run this milestone produces sets
  it. `Report.css` stays optional in the type for backward compatibility with pre-M82 reports.
- `formatTable`'s `Stylesheets:` line prints unconditionally (previously gated on
  `files.length > 0`) whenever `report.css` is present.
- The three `buildEnvFingerprint` call sites' `css` guard changes from a truthy check on
  `cssReport` to `cssReport && cssReport.files.length > 0`, to hold fingerprint bytes constant for
  the no-CSS case (see above) — this is a fix, not a behavior change, from the fingerprint's own
  point of view.

## Does NOT include

- Widening the fallback (or entry/known-name) scan beyond the current `projectRoot` to sibling
  workspace packages or the workspace root. Cal.com's real Tailwind entry lives in `apps/web`,
  unreachable from `packages/ui`; this milestone discloses that honestly (`noEntryInPackage`) but
  does not go looking for it elsewhere — that is a discovery-scope change belonging to alias/config
  resolution (M76 owns where alias sources come from and in what order).
- Determining what counts as "reachable" from scratch. Reachability is exactly what
  `entryStylesheetImports` (M71) already resolves through the tsconfig/vite alias tables `M69`
  builds; this milestone adds validation and disclosure around the fallback layer, it does not
  change what "reachable" means or how aliases are found.
- Preprocessor-missing error wording, or any wording for a diagnostic produced on an
  already-failed build. `CSS_PREPROCESSOR_MISSING_WARNING` (M71) is unchanged. Whether a warning
  computed before a harness-build crash survives to be printed is M79's (`Diagnostics survive the
  failure path`) — this milestone computes the CSS decision correctly and disclosably; getting that
  disclosure through an unrelated build crash is out of scope.
- `--css`/`--no-css` flag parsing, validation, or interaction changes beyond the disclosure text
  they now produce (`layer: "explicit"` / `"disabled"`). Flag parity is M83's.
- Extending `--explain-props` to disclose CSS. It stays a TS-only dry run (M65); no browser, no
  Vite, no stylesheet decision is made on that path today, and this milestone does not add one.
- A real CSS parser, or executing PostCSS/Sass to determine plausibility. `stylesheetRuleCount` is
  a text-only heuristic (comment/at-rule stripping plus a `{` count), matching the "text only,
  nothing executed" invariant M71 set for `readViteConfigData`.
- Detecting every runtime CSS-in-JS library that exists. `RUNTIME_STYLE_ENGINES` is a fixed
  allowlist matching the evidence (ant-design's cssinjs, chakra's Emotion, primevue's runtime
  style module). An unrecognized engine still resolves to `layer: "none"` rather than
  `"runtime"` — a known, disclosed limitation, and strictly no worse than today's total silence.
- Detecting a runtime style package that is installed only inside another dependency's own nested
  `node_modules` and never hoisted. `detectRuntimeStyleEngines` reuses `isPackageAvailable`
  unchanged, with the same reach (declared, or on the ancestor `node_modules` resolution chain)
  `detectUnsupportedStyleEngines` already has and the same limitation.
- Applying the two disqualification checks (placeholder, opt-in reset) to layers 1-3. An entry
  import or a known-name candidate is evidence-backed; second-guessing it is out of scope (see
  Scope's opening principle).

## Acceptance

- A project with no `index.html`/Next entry stem, no known-name candidate, one CSS file
  (`components/style/reset.css`, real reset rules) and `@ant-design/cssinjs` declared: `layer:
  "runtime"`, `files: []`, `runtimeEngines: ["@ant-design/cssinjs"]`; `reset.css` never appears in
  `report.css.files`, and a warning names it as skipped (opt-in reset, unreferenced).
- The same project without `@ant-design/cssinjs` declared: `layer: "none"`, `files: []`; the same
  skip warning still fires.
- A project whose only stylesheet is `src/styles.css` containing only `@import "pkg";` (67 bytes,
  rule count 0) and no other CSS anywhere under the root: `layer: "none"` (no runtime engine
  declared), with a warning naming the file as an unbuilt placeholder.
- The same project with a second, real stylesheet elsewhere under the same root (non-trivial rule
  count): the placeholder is skipped and warned about, the real file is injected, `layer:
  "largest-fallback"`, `details` reports its byte size and a non-zero rule count.
- A monorepo member with no entry of its own and no known-name candidate, one unrelated component
  stylesheet with real rules under its root: injected (behavior unchanged from M71), `layer:
  "largest-fallback"`, `onlyCandidate: true`, `noEntryInPackage: true`; both the console line and
  the warning name the file and state the package has no application entry of its own.
- A conventional single-package app whose `app/globals.css` is reachable from its entry (the
  control case): unchanged pick, `layer: "entry-chain"`, `details` reports its byte/rule count;
  this run must not regress relative to M71's existing acceptance for this shape.
- A project with zero stylesheets anywhere and no runtime engine declared: `report.css` is present
  (not `undefined`) with `files: []`, `layer: "none"`; the JSON always carries a `css` key.
- `--no-css`: `layer: "disabled"`, `files: []`, console prints `Stylesheets: none (--no-css)`.
- Explicit `--css path.css` naming a near-empty file: still injected unconditionally (the user's
  choice is not second-guessed), `layer: "explicit"`, `details` reports its small byte/rule count.
- A project with zero stylesheets and `@emotion/react` + `@emotion/styled` declared (chakra-ui
  shape): `layer: "runtime"`, `runtimeEngines: ["@emotion/react", "@emotion/styled"]` — the F9 PASS
  outcome is unchanged, now stated instead of silent.
- A project with no stylesheet found at all: the three `buildEnvFingerprint` call sites omit the
  `css` fingerprint key exactly as before this milestone, even though `report.css` itself is now
  present with `layer: "none"`.
