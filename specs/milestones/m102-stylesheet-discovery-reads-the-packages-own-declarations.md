---
kind: milestone
status: draft
tests:
  - test/unit/package-declared-stylesheets.test.ts
  - test/unit/stylesheet-match-stats.test.ts
  - test/unit/entry-stylesheet-discovery.test.ts
  - test/unit/stylesheet-disclosure-completeness.test.ts
---

# M102: stylesheet discovery reads the package's own declarations and discloses what applied

Lane A (+ I6 already landed, I7 consumed by Lane C). Closes heroui-F1, mantine-F1, shadcn-ui-F1,
shadcn-ui-F2, and produces the evidence shadcn-ui-F3 and excalidraw-F2 need.
Not closed (by design, M82): calcom-F1. Root cause: `C:\Projekte\120fps-fieldtest\verify\V8-css-discovery.md`.

## Purpose

Three separate failures share one cause — discovery reads names and sizes, never what the package
says about itself:

- **heroui** ships `packages/react/package.json` `exports["./styles"] -> ./src/styles.css`, a
  one-line passthrough (`@import "@heroui/styles";`). Discovery rejected it as a 0-rule placeholder
  (correctly) and stopped, reporting `Stylesheets: none found` for all five candidates, while the
  real ~600-line stylesheet sat one `@import` hop away in an installed package
  (`packages/styles/index.css`, reachable through that package's own `exports["."].style`).
  `GLOBAL_CSS_CANDIDATES` also lists `src/style.css` and not `src/styles.css`, so the conventional
  layer missed the same file by one character.
- **shadcn** injects `apps/v4/app/globals.css`, whose own `@import "shadcn/tailwind.css"` resolves
  through the package's `exports["./tailwind.css"] -> ./dist/tailwind.css` — a directory that does
  not exist until that package is built. 120fps never looked, so Vite's PostCSS pipeline hit it
  first, at different moments for different components: for `button.tsx`/`chart.tsx` the failure
  arrived where `analyze()` can recover it (warn, drop, measure unstyled), for
  `select.tsx`/`sidebar.tsx` it arrived as a detached dependency-optimizer rejection and became a
  fatal exit 2 with no report at all. Same condition, two outcomes, and the message named
  `E:\repositories\shadcn-ui\shadcn\tailwind.css` — a path assembled from the specifier that exists
  nowhere on disk.
- **excalidraw** injects `css/styles.scss`, whose every rule is nested under `.excalidraw`; the
  harness mounts no such ancestor, so zero rules can match and `Result: PASS` describes an entirely
  unstyled button. Nothing measured whether the injected CSS applied.

## Contract

- inputs: a project root (a workspace member's own root, never an ancestor application's), its
  manifest, its files, and the stylesheets a run injects.
- outputs: the stylesheet files to inject, each disclosed with the evidence that chose it; a page-side
  count of how many of each injected sheet's rules match the rendered tree.
- constraints: no CSS parser and no preprocessor execution (M82 non-goal) — the `@import` hop is a
  one-level scan of `@import` statements, and the match count is CSSOM, which the browser already
  parsed; resolution never leaves the member package's own dependency graph.
- non-goals: following an `@import` chain more than one hop; consulting an ancestor application's
  entry for a library package (M82's explicit exclusion, cal.com's case).

## MUST (from `specs/milestones/M97-M106-MAP.md`)

- The measured package's own `package.json` `style`, `exports["./styles"]`, `exports["./style.css"]`
  and `exports[*].style` are stylesheet candidates ranked above the largest-file fallback; a
  candidate that is a 0-rule passthrough has its `@import` targets resolved one hop (bare specifiers
  through `resolveBareStylesheetSpecifier`), and the resolved files become the candidates.
- `GLOBAL_CSS_CANDIDATES` includes `src/styles.css` next to `src/style.css`.
- A stylesheet read failure names the path that was actually tried (the resolved real path, e.g.
  `packages/shadcn/dist/tailwind.css`), never a path assembled from the specifier that does not exist.
- The same unreadable-stylesheet condition has one outcome: warn, drop, measure unstyled. The fatal
  path select.tsx/sidebar.tsx hit is traced (surface stated below) and routed to the same warning.
- `css.details` is populated whenever `layer` is set (`unreadable` entries carry the file and the
  reason), and per I7 carries `matchedRules`.

## MUST NOT

- Consult an ancestor application's entry for a library package (M82).

## Design

### Where the fatal-vs-warn asymmetry actually lives

Both shapes are the identical PostCSS `ENOENT` on the same nested `@import`; they differ only in
which surface the rejection reaches:

| component | arrival surface | handler | outcome |
|---|---|---|---|
| `button.tsx`, `chart.tsx` | the first real page request, inside `enterHarnessPage()` | `src/analyze.ts:3050-3090` — `stylesheetReadFailureTarget` matches, CSS is dropped, the harness is rebuilt without it | warning, full report |
| `select.tsx`, `sidebar.tsx` | Vite's fire-and-forget dependency-optimizer scan, rejecting *after* `buildAndServe` already resolved | `process.on("unhandledRejection")` -> `resolveFatalProcessError` (`src/cli.ts:891`, M79/M94 surface 3) | `Error:`, exit 2, no report |

The recovery in `analyze.ts` wraps exactly one call (`enterHarnessPage`), so a rejection that never
passes through it cannot be recovered there, and the CLI's global handler is by design a *fatal*
handler — it exists to turn a raw esbuild stack into a diagnosed exit 2. Neither side is wrong on
its own; what is wrong is that the condition was allowed to reach the bundler at all, when it is
decidable from the filesystem before the server ever starts. M102 removes the asymmetry at its
source: a stylesheet whose own `@import` names a file that does not exist is never injected, so
neither surface fires, and both components take the same warn-and-measure-unstyled path.

### One `@import` hop, three uses

`stylesheetImportSpecifiers(file)` reads a stylesheet's own `@import` statements (comments stripped,
`url()` and quoting normalized, media/layer suffixes and `?query` dropped) — no CSS parser, the same
text-level treatment `stylesheetRuleCount` already applies. `resolveStylesheetImportTarget` resolves
one specifier the way a bundler would, and reports the difference between "resolves to a file" and
"names a file that does not exist":

- relative / root-absolute / tsconfig-alias: the existing `resolveStylesheetSpecifier` path;
- bare with a subpath (`shadcn/tailwind.css`): `resolveBareStylesheetSpecifier`, extended to report
  the *declared* target when the package's `exports` names one that is absent;
- bare package root (`@heroui/styles`): the package's own `style` / `exports["."].style|default`,
  accepted only when it names a stylesheet extension.

That one resolver serves three MUSTs: expanding a passthrough candidate, naming the real missing
path, and rejecting an injectable stylesheet whose nested import is missing.

### Discovery layers

Layer order becomes: entry imports (1) -> the package's own manifest declarations (2) -> conventional
filenames (3) -> size-ranked fallback (4) -> runtime engines -> none. The manifest sits above
conventional names because it is evidence rather than convention (M71's own ordering principle) and
above the fallback as the MUST requires. `packageStylesheetCandidates` reads, in order, `style`,
`exports["./styles"]`, `exports["./style.css"]`, then any other `exports[*].style`.

Every candidate from layers 2 and 3 passes through `expandPassthroughStylesheet`: a candidate with
at least one rule of its own is used as-is; a 0-rule passthrough is replaced by its resolved
`@import` targets, disclosed with `CSS_PASSTHROUGH_RESOLVED_WARNING` naming both the passthrough and
what replaced it. A passthrough whose imports resolve to nothing keeps today's outcome — skipped,
with `CSS_PLACEHOLDER_SKIPPED_WARNING`.

Every file any layer is about to return passes `rejectBrokenNestedImport`: when one of its own
`@import`s names a file that is declared and absent, the file is dropped with
`CSS_BROKEN_IMPORT_SKIPPED_WARNING` naming the *resolved* path (`packages/shadcn/dist/tailwind.css`)
and the package build that produces it, and it is remembered as rejected for every later layer in
the same call, so the conventional layer cannot re-pick what the entry layer just rejected.

`CssDiscovery.source` gains one value, `"package-declared"`, for a pick made from the measured
package's own manifest; a conventional filename still reports `"candidate"`. Lane C maps it to
`layer: "package-declared"` and prints "declared by the measured package's own package.json"
(`report.ts`), so a real pick is never labelled as a filename guess.

### I7: did the injected CSS apply?

The generated entry gains `window.__120fps.stylesheetMatchStats()`, returning one
`{ file, rules, matched }` per injected global stylesheet. It reads `document.styleSheets`, keyed to
the injected files by Vite's own `data-vite-dev-id` attribute on the `<style>` element it creates,
walks `cssRules` (descending into `@media`/`@supports`/`@layer` groups), counts every rule with a
`selectorText`, and counts as matched those whose selector matches at least one element under
`#root`. Every sheet and every selector is individually `try`/`catch`ed: a cross-origin sheet
(`cssRules` throws) is skipped, an exotic selector `querySelector` rejects counts as unmatched. No
CSS parser, no preprocessor, no network — CSSOM has already parsed all of it.

## Open questions

- `css.details` (the last MUST, shadcn-ui-F3) is built in `src/analyze.ts:2658` and emptied at
  `:3074`, both Lane C files. Implemented there, not here; listed as an interface request.

## Verification

### Unit

`pnpm vitest run test/unit/package-declared-stylesheets.test.ts test/unit/stylesheet-match-stats.test.ts
test/unit/entry-stylesheet-discovery.test.ts test/unit/css-injection.test.ts
test/unit/stylesheet-candidate-validation.test.ts test/unit/vue-support-harden.test.ts`:

```
 Test Files  5 passed (5)
      Tests  187 passed (187)
```

(the first three plus the three existing files whose own expectations this milestone changes: the
candidate list gained `src/styles.css`, and `vue-support-harden`'s "no Vue vocabulary" token `h(`
became `/\bh\(/`, since a bare `h(` substring also occurs inside `push(`.)

Lane-wide `pnpm vitest run test/unit/ --maxWorkers=4 --reporter=dot` (all three lanes' files):

```
 Test Files  252 passed (252)
      Tests  4005 passed | 1 skipped (4006)
```

`pnpm lint` (`tsc --noEmit`): clean.

### Real repositories

heroui, the F1 repro (`logs/fix-a-m102-heroui2.log`) — was
`Stylesheets: none found (checked the project entry, conventional filenames, and the largest
stylesheet under the project)` for all five candidates:

```
$ cd /e/repositories/heroui && node /c/Projekte/120fps/dist/cli.js     packages/react/src/components/badge/badge.tsx --samples 3 --max-combos 2 --explore-budget 20
Stylesheets: node_modules/@heroui/styles/index.css (declared by the measured package's own package.json)
...
⚠ src/styles.css declares no CSS rule of its own; the stylesheet it imports,
  node_modules/@heroui/styles/index.css, was injected in its place
"css":{"files":["node_modules/@heroui/styles/index.css"],"autoDetected":true,
       "layer":"package-declared","details":[{"file":"node_modules/@heroui/styles/index.css",
       "bytes":588,"rules":0,"matchedRules":0}]}
```

shadcn, the F1/F2 repro (`logs/fix-a-m102-shadcn.log`) — `select.tsx` used to abort at exit 2 with
no report at all, while `button.tsx` warned and measured; both now take the same path, and the named
path is the one the package's own exports map declares:

```
$ cd /e/repositories/shadcn-ui && node /c/Projekte/120fps/dist/cli.js     apps/v4/registry/new-york-v4/ui/select.tsx --samples 3 --max-combos 2 --explore-budget 30
Stylesheets: app/(app)/(typeset)/typeset.css (found in the project entry's own imports)
...
Result: FAIL
⚠ app/globals.css imports "shadcn/tailwind.css", which resolves to
  node_modules/shadcn/dist/tailwind.css — a file that does not exist, most likely because it is
  generated by a build this harness never runs. The stylesheet was not injected and the component is
  measured unstyled; run that package's build, or pass --css to name a stylesheet that resolves.
Total: 23.9s
```

The `Result: FAIL` is the component's own (`SelectContent` must be used within `Select`, the
finding's own P6 ground truth), reached through a full report — the outcome the fatal path denied it.

excalidraw, the F2 repro (`logs/fix-a-m102-excalidraw2.log`) — I7's count, consumed by Lane C:

```
$ cd /e/repositories/excalidraw && node /c/Projekte/120fps/dist/cli.js     packages/excalidraw/components/FilledButton.tsx --samples 3 --max-combos 2 --explore-budget 20
Stylesheets: css/styles.scss (largest-stylesheet fallback, low confidence — verify with --css)
...
⚠ css/styles.scss was injected and none of its 158 rules matched anything the component rendered:
  the measurement describes an unstyled render. A stylesheet scoped under an ancestor class or id
  the harness does not render (a theme root, an app shell wrapper) needs a --wrap module that
  renders that ancestor.
"details":[{"file":"css/styles.scss","bytes":21142,"rules":158,"matchedRules":0}]
```

`git status --porcelain` is empty in all three repositories afterwards, with no harness directory and
no `120fps-report.json` left behind.
