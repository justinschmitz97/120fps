---
kind: milestone
status: approved
tests:
  - test/unit/hints.test.ts
  - test/unit/prop-synthesis-image-src.test.ts
  - test/unit/a-render-failure-names-its-provider.test.ts
  - test/unit/a-dimension-prop-synthesizes-a-number.test.ts
  - test/unit/an-element-type-prop-synthesizes-a-tag.test.ts
  - test/unit/a-growth-hint-needs-a-tree-that-rendered.test.ts
  - test/unit/a-placeholder-value-in-the-dom-is-disclosed.test.ts
  - test/unit/the-exit-code-line-covers-a-render-error.test.ts
---

# M133: a render failure names its provider, its bad value, and nothing that never rendered

Lane D (`src/project/preflight.ts` provider tables, `src/report/hints.ts`, `src/props/synthesize.ts`,
`src/pipeline/build-report.ts`, `src/cli/help.ts`). The README rewording is an interface request to
the coordinator.

## Purpose

Eight of the fifty run-7 repositories ended in a verdict failure, and six of those were render
failures. Three of the six printed a generic remedy with no suspect, although the page error named
the missing provider in plain text and the component's own first import named the library. One
printed a growth hint fitted over six combos that never rendered. One rendered an SVG at
`width="test"` on every sample because a prop named `size` was given a string placeholder, and the
disclosure that would have named it was gated off. And the help text describes exit 1 as "over
budget, or a regression", which is not what a render crash is. After this milestone a render failure
names the provider it suspects and why, a value that reached the DOM as a placeholder is disclosed,
a hint is never fitted over a tree that did not render, and the exit codes are described the way the
tool uses them.

Evidence: `C:/Projekte/120fps-fieldtest/smoke/run7-FINDINGS.md` cluster 5 (F19-F23) and the logs of
docmost, ai-chatbot, dub, trigger.dev and linkwarden in `smoke/run7-smoke1/`.

## Root causes (verified)

The verifier for every item below: run-7 investigation (2026-09-06), refuted by default; logs under
`C:/Projekte/120fps-fieldtest/smoke/run7-smoke1/logs/<repo>/`.

1. **The provider table does not cover the libraries the corpus uses** — `PROVIDER_LIBRARIES`
   (`src/project/preflight.ts:54-66`) lists ten packages (`next-intl`, `react-i18next`, `react-redux`,
   `@tanstack/react-query`, `react-router`, `react-router-dom`, `@remix-run/react`, `gatsby`,
   `@tanstack/react-router`, `@tanstack/react-start`) and `PROVIDER_LIBRARY_SCOPES`
   (`src/project/preflight.ts:69`) is `["@radix-ui/"]`. The verifier: docmost imports `@mantine/core`
   on line 1 of the measured component, gets no suspect at all (`providerCandidates` undefined), and
   its page error says `MantineProvider was not found`. Three of the six render failures print the
   generic remedy with no suspect: docmost, ai-chatbot (`Primitive.label failed to slot`) and dub
   (which M130 fixes at its own root). Ranking by an error-text needle is already implemented at
   `src/report/hints.ts:417`. The remedy itself works: a six-line `120fps.setup.tsx`
   (`README:235-245`) flipped bulletproof-react from FAIL to PASS and is auto-detected at the member
   root (`src/harness/exports.ts:21-40`).
2. **A growth hint is fitted over combos that never rendered** — in `src/report/hints.ts` the
   `renderHealth` guard at `:331-333` protects `budgetBreach`, but the curve loop at `:336-338`
   (`if (isSuperlinearGrowth(curve)) found.add("superlinearGrowth")`) sits outside it. The verifier:
   trigger.dev emits `superlinearGrowth` from a curve fitted over six combos whose `domNodeCount` is 0
   and whose `renderHealth` is `error`. Pinned by `test/unit/hints.test.ts:95-105`.
3. **A dimension prop gets a word where a number is required** — `namedStringValue`
   (`src/props/synthesize.ts:331-337`) has name-based rules for currency (`:333`), locale (`:334`) and
   image source (`:335`), built from constants at `:319`, `:321` and `:324`; there is no dimension
   rule. The verifier: linkwarden's `size: string` synthesizes `"test"`, which renders
   `<svg width="test" height="test">`, produces five browser errors, and makes the SVG fall back to
   300×150 on every sample — so every measurement is of a different element than the app renders.
4. **The harness-fault disclosure is gated off exactly where it applies** — `detectHarnessFault`
   (`src/pipeline/build-report.ts:104-133`) would have matched linkwarden's placeholder value, but
   its call site is gated at `src/pipeline/build-report.ts:353`
   (`if (combo.verdict !== "fail" || combo.renderHealth !== "error") continue;`). The verifier: a
   combo that rendered 39 nodes and produced page errors gets no `[harness fault]` line, because it
   neither failed nor reported a render error.
5. **A slot that takes a tag or a component is measured as `undefined`** — `classifyTypeByShape`
   (`src/props/classify.ts`) had no rule for `React.ElementType`, whose union carries every
   intrinsic tag literal beside `ComponentClass` and `FunctionComponent`. The verifier: dub's
   `ui/shared/empty-state.tsx` extracts `icon` as required (M130) and every combo threw
   `Element type is invalid … but got: undefined` — `logs/run7-lane-b/dub/`.
6. **The help text describes exit 1 as something else** — `src/cli/help.ts:57` reads
   `1   a verdict failed: over budget, or a regression under --check/--budget`, and `README:97`
   repeats it, while `specs/overview/01-glossary.md:169` records that a `renderHealth` error forces a
   fail and `:175` defines fail as exceeding a threshold. The verifier: a render crash exits 1 and is
   described by neither clause. `README:353-355` (`#render-errors`) has no example and no link to the
   working recipe at `README:235`.

## MUST

- **C1** `PROVIDER_LIBRARY_SCOPES` covers `@mantine/`, `@chakra-ui/` and `@trpc/` beside
  `@radix-ui/`, so a component whose imports name a package in one of those scopes yields a
  provider candidate. `PROVIDER_LIBRARIES` names the representative hook of the context libraries
  the deep run found: `react-intl` (`useIntl`), `jotai` and `jotai-scope` (`useAtom`),
  `@trpc/tanstack-react-query` (`useTRPC`) and `@trpc/react-query` (`useQuery`).
- **C2** When more than one provider candidate exists, they are ranked by whether the captured page
  error text names them, using the needle mechanism already at `src/report/hints.ts:417`. The remedy
  names the top candidate, states the evidence — the import, and the page-error phrase when there was
  one — and points at the `120fps.setup.tsx` / `120fps.setup.vue` recipe and the package root where
  it is auto-detected. Exactly one line reads as the suspect; the remaining candidates keep the
  line they already had. The needle drops every trailing `Provider`/`Context`, so
  `OperatingSystemContextProvider` ranks `OperatingSystemProvider.tsx` first.
- **C3** A render failure with no provider candidate keeps today's generic remedy, unchanged.
- **C4** No hint is derived from a combo whose `renderHealth` is `error`: the curve loop moves inside
  the guard that already protects `budgetBreach`, so a curve fitted over non-rendering combos
  produces no `superlinearGrowth`. Curve mode has no combos, so its own curves are guarded by the
  `curveRenderError` and `curveRenderedNothing` facts the report already computes.
- **C8** A prop whose type accepts an intrinsic tag *and* a component — `React.ElementType` and the
  aliases that expand to the same union — synthesizes the string `"div"` with provenance
  `heuristic`, so a required slot renders instead of reaching React as `undefined`. A hand-written
  literal union of tag names stays the enumeration it declares; a prop the contract rule already
  owns (`as`, `asChild`, `render`) keeps its `contract` provenance.
- **C5** A prop whose name matches a dimension — `/^(width|height|size|x|y|r|cx|cy|rx|ry|strokeWidth)$/i`
  — and whose type is `string` synthesizes `"16"`, with provenance `heuristic`, in the same place the
  currency, locale and image-source rules live.
- **C6** When a synthesized placeholder value reaches the DOM of a combo that rendered, the run
  discloses `[harness fault]` in `report.warnings`, naming the prop, the value, its provenance and
  the page error that names it — the element the reader would look for is in that error text. The
  disclosure never changes a verdict, and it never sets `combo.harnessFault`, whose only meaning
  stays the fail-and-render-error exemption `Result: PASS` is computed from. A combo that rendered
  has no crash corroborating the match, so its evidence bar is higher than the crashed combo's: the
  error text is read without 120fps's own `(×N)` repeat suffix and without `:line:column` stack
  positions, and a value shorter than three characters that is all digits — `"16"`, `"1"` — is never
  evidence, because it also spells a React error code and a line number.
- **C7** `--help` describes exit 1 as the union of what the tool actually returns it for: a verdict
  that failed — over budget, a regression under `--check`/`--budget`, or a render error. The README
  rewording (`README:97`, `README:353-355` gaining an example and a link to `README:235`) is filed
  with the coordinator as an interface request and referenced from this spec's Verification when it
  lands.

## MUST NOT

- Change an exit code. Exit 1 stays what M59 made it, and the JSON report already carries
  `renderHealth` for a consumer that needs the distinction. C7 is wording only.
- Flip a verdict from a disclosure. C6 discloses; the verdict is decided where it already is.
- Name a provider the run did not observe in the component's own imports. A package in scope but not
  imported by the measured file is not a candidate.
- Print more than one provider suspect as *the* suspect. C2 ranks and names one, with the rest
  available in the JSON if they are already carried there.
- Extend the dimension rule to a prop whose type is a number, a union of literals, or an enum — those
  already synthesize correctly and C5 must not shadow them.
- Read C8's element-type shape from a type *name*. The rule fires on the structure — every intrinsic
  tag literal plus a callable or constructable member — so a renamed alias is still covered and a
  literal union that happens to contain `"div"` is not.
- Change the `120fps.setup.*` detection or the recipe itself; both are M114 and M127 surface and both
  are recorded as working.

## Verification

- **C1, C2, C3** — `test/unit/a-render-failure-names-its-provider.test.ts`: a component importing
  `@mantine/core` whose page error says `MantineProvider was not found` yields `@mantine/core` as the
  ranked suspect with the page-error phrase as evidence; a component importing both `@chakra-ui/react`
  and `react-redux` where the error names Chakra ranks Chakra first; a component with no provider
  import keeps the generic remedy; a package in scope but not imported yields no candidate.
- **C4** — `test/unit/a-growth-hint-needs-a-tree-that-rendered.test.ts` and
  `test/unit/hints.test.ts` (`:95-105`): six combos with `renderHealth: "error"` and `domNodeCount: 0`
  produce no `superlinearGrowth`; the same curve with healthy combos still produces it; a curve-mode
  report whose scale points threw, and one whose points all rendered nothing, produce none either;
  `budgetBreach` behaviour is unchanged.
- **C5** — `test/unit/a-dimension-prop-synthesizes-a-number.test.ts` and
  `test/unit/prop-synthesis-image-src.test.ts`: `size: string`, `width: string`, `strokeWidth: string`
  each synthesize `"16"` with provenance `heuristic`; `label: string` does not; `size: number` is
  untouched; `size: "sm" | "lg"` is untouched. A fixture sibling of `fixtures/m84/image-src.tsx`
  carries the shape.
- **C8** — `test/unit/an-element-type-prop-synthesizes-a-tag.test.ts`: `icon: ElementType`
  (required) and `component?: ElementType` each synthesize `"div"` with provenance `heuristic`;
  `title: string` beside them keeps `"test"`; `as?: ElementType` keeps `contract`; a
  `"div" | "span" | "button"` union keeps all three values and `declared`.
- **C6** — `test/unit/a-placeholder-value-in-the-dom-is-disclosed.test.ts`: a combo with
  `verdict: "pass"`, `renderHealth: "ok"`, 39 rendered nodes and a placeholder value in the DOM
  produces the `[harness fault]` disclosure and keeps `verdict: "pass"`; a combo with no placeholder
  produces none; the existing fail-and-error path still discloses.
- **C7** — extend `test/e2e/cli.test.ts`'s help assertion or its unit equivalent: `--help` names the
  render-error case in the exit-1 line.
- Types: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` clean.
- Suite: the tests above plus `test/unit/harness-fault.test.ts`,
  `test/unit/harness-fault-harden.test.ts`, `test/unit/prop-synthesis*.test.ts`,
  `test/unit/curve-render-error-hint.test.ts`, `test/unit/preflight.test.ts`, then the full unit suite
  once before the lane's final commit.

Recorded run of this milestone's verification (2026-09-07, worktree
`C:/Projekte/120fps-run7-lane-d` merged with `feat/run7-remediation` at `cc506f0`, node 22.22.2):

```
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
-> exit 0, no output

npx vitest run test/unit/a-render-failure-names-its-provider.test.ts   test/unit/a-growth-hint-needs-a-tree-that-rendered.test.ts   test/unit/a-dimension-prop-synthesizes-a-number.test.ts   test/unit/a-placeholder-value-in-the-dom-is-disclosed.test.ts   test/unit/an-element-type-prop-synthesizes-a-tag.test.ts   test/unit/the-exit-code-line-covers-a-render-error.test.ts   test/unit/hints-captured-error.test.ts test/unit/hints.test.ts   test/unit/curve-render-error-hint.test.ts test/unit/prop-synthesis*.test.ts   test/unit/dx-features.test.ts test/unit/preflight.test.ts --maxWorkers=2
-> Test Files  17 passed (17);  Tests  267 passed (267)

npx vitest run test/unit --maxWorkers=2
-> Test Files  2 failed | 387 passed (389)
   Tests  2 failed | 5387 passed | 1 skipped (5390)
   Duration 465.23s
   the two failures are the recorded pre-existing set: prop-cap-ranking.test.ts and
   vue-setup-inject-evidence.test.ts
```

Recorded run of the review fixes (2026-09-07, merged with `feat/run7-remediation` at `55f5102`):

```
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json   -> exit 0, no output

npx vitest run <the 16 files this lane's two milestones touch> --maxWorkers=2
-> Test Files  16 passed (16);  Tests  169 passed (169)

npx vitest run test/unit --maxWorkers=2
-> Test Files  2 failed | 389 passed (391)
   Tests  2 failed | 5455 passed | 1 skipped (5458)
   Duration 460.04s
   the two failures are the recorded pre-existing set: prop-cap-ranking.test.ts and
   vue-setup-inject-evidence.test.ts
```

Corpus repros, through a `dist` built in `C:/Projekte/120fps-run7-lane-d`:

```
node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run6/docmost/apps/client \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-d/docmost \
  --label m133-docmost --cli C:/Projekte/120fps-run7-lane-d/dist/cli/main.js \
  -- src/components/ui/empty-state.tsx --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# expected: the remedy names @mantine/core as the ranked suspect (baseline: no suspect)

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run5/ai-chatbot \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-d/ai-chatbot \
  --label m133-ai-chatbot --cli C:/Projekte/120fps-run7-lane-d/dist/cli/main.js \
  -- <realTarget from smoke/run7-smoke1/ai-chatbot.json> --samples 3 --max-combos 2 \
     --explore-budget 30 --no-deltas
# expected: the @radix-ui/ suspect named and ranked by the error text

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run6/trigger.dev/apps/webapp \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-d/trigger.dev \
  --label m133-trigger --cli C:/Projekte/120fps-run7-lane-d/dist/cli/main.js \
  -- app/components/primitives/Switch.tsx --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# expected: no superlinearGrowth hint; the render error is what is reported

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run6/linkwarden/apps/web \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-d/linkwarden \
  --label m133-linkwarden --cli C:/Projekte/120fps-run7-lane-d/dist/cli/main.js \
  -- components/ui/Loader.tsx --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# expected: size -> "16" (provenance heuristic), no <svg width="test">, no 300x150 fallback;
#           any remaining placeholder in the DOM disclosed as [harness fault] without a verdict flip

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories/calcom/apps/web \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-d/calcom \
  --label m133-control --cli C:/Projekte/120fps-run7-lane-d/dist/cli/main.js \
  -- modules/apps/components/Slider.tsx --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# expected: still verdict-fail, exit 1
```

Recorded corpus results (2026-09-07, `dist` built at this commit; logs under
`C:/Projekte/120fps-fieldtest/logs/run7-lane-d/<repo>/`):

| Repo | Before | After |
|---|---|---|
| docmost | verdict-fail, generic remedy, `providerCandidates` undefined | `component imports @mantine/core, and the page error says "@mantine/core: MantineProvider was not found in component tree, make sure you have it in your app": render it inside that provider. A default-exporting 120fps.setup.tsx (or 120fps.setup.vue) at the package root is picked up automatically; --wrap names another path.` |
| trigger.dev | `cost grows faster than the data` fitted over six `renderHealth: "error"` combos (`grep -c` = 1) | `grep -c` = 0; the render error is what is reported, and the suspect line names the page-error phrase |
| linkwarden | 8 `<svg> attribute width: Expected length, "test"` errors, verdict-fail | `grep -c` = 0; `Result: PASS`, exit 0 in 30 s; `grep -c 'harness fault'` = 0 — no placeholder reaches the DOM, so no disclosure is due |
| dub | every combo `Element type is invalid … but got: undefined`, 0 DOM nodes (13 error lines) | combos 0 and 1 render 8 and 4 DOM nodes (`WARN`); the four `__120fps_scaleN` probes still throw, which is the scale-probe prop path, not this rule |
| bulletproof-react | `component imports react-router (useNavigate): likely needs a provider wrapper; see --wrap / 120fps.setup.tsx` for a file that imports only `Link` | `component imports react-router, and the page error says "Cannot destructure property 'basename' of 'React10.useContext(...)' as it is null.": render it inside that provider. …` |
| ai-chatbot | verdict-fail, `Primitive.label failed to slot` | `Result: PASS` |
| calcom (`--curve`, control) | `Growth: mount linear, rerender linear`; `Result: FAIL [render error]`, exit 1 | unchanged: no growth hint was due, and none prints; the curve-mode guard is pinned by unit tests instead |
| calcom (control) | verdict-fail, exit 1 | `Result: FAIL [render error]`, exit 1, generic remedy unchanged (no candidate found); `--help` and `README:97` now describe exit 1 the same way |

## Deferred

- **One-letter dimension names.** C5's `x`, `y`, `r` are as likely to be a coordinate the component
  computes as an SVG attribute; the rule fires on them because the corpus offered no counter-example,
  and a repository that synthesizes a wrong `x` is what would narrow it.
- **Suppressing a suspect the run itself hoisted.** A provider candidate reached only through a
  dependency 120fps installed for the harness is still named; separating the two needs the install
  provenance the resolver does not carry today.

- **The exit-code redesign.** The findings keep exit 1 (M59 is explicit; the JSON already carries
  `renderHealth`). C7 rewords the description; a distinct code for a render crash is a separate
  decision.
- **The README changes** (`README:97`, `README:353-355`, the example and the link to `README:235`) —
  the coordinator's file, filed as an interface request.
- **Provider *detection* from the page error alone.** C2 ranks candidates the imports produced; a
  suspect derived only from an error string would name a package the component never imported.
- **Auto-generating the `120fps.setup.*` wrapper.** The remedy is documented, works, and is
  auto-detected; generating it is M136's option (c), which the findings mark opt-in only.
- **linkwarden's remaining rerender cost.** The value fix removes the fallback element; the ~16 s of
  per-sample overhead the log does not decompose is M134's.

## Approval

Approved 2026-09-07 on the merged branch feat/run7-remediation (commits `8149597`, `cf9c132`).
Adversarial review by an independent agent: needs-fix → fixes → approve. Unit suite on the merged
tree: 391 files / 5455 passed / 2 pre-existing failures / 1 skipped.
