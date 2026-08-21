---
kind: milestone
status: draft
---

# M84-M96 map: field-test run 2 remediation

Coordination document for the thirteen milestones remediating the 2026-08-20 field test run 2
(`C:\Projekte\120fps-fieldtest\run2\REPORT.md`, 104 findings across 20 repositories, 13 root-cause
groups). Delete this file once all thirteen specs are approved; it exists to keep their boundaries
from overlapping.

Evidence: `C:\Projekte\120fps-fieldtest\run2\` — `REPORT.md` (verdict), `EVIDENCE.md` (every finding
with a repro plus the G1-G13 dedup map), `findings/<repo>.md`, `profiles/<repo>.md`, `logs/`.

Baseline at authoring time: 198 unit test files pass, `tsc --noEmit` clean.

## Goal

All twenty corpus repositories run with the least possible configuration. Three of them
(solid-ui/Solid, pnp-app/Yarn PnP, preact-app/react-dom 17) are **out of scope for measurement** by
explicit decision: their clean refusals already count as correct behavior, and these milestones only
sharpen their messages. The other seventeen must reach a report.

Where a component genuinely cannot resolve without the repository's own build step, the tool
**degrades and measures what it can**; where that is impossible it **fails fast naming the exact
command to run**. It never requires a build silently and never emits a raw bundler stack trace.

## Ordering: by universality, not by repository

Run 2's corpus is 17 of 20 workspace monorepos and 11 of 20 component libraries. That over-weights
unbuilt-library-source defects relative to what a developer measuring their own application component
actually hits. The waves below are ordered so that defects affecting **every** user land before
defects that only affect an unbuilt library source tree.

| Wave | Milestones | Audience |
|---|---|---|
| 1 — correctness | M84, M85, M86, M87 | every user |
| 2 — reliability | M88, M89 | every user |
| 3 — honesty | M90, M91, M92 | every user |
| 4 — resolution | M93, M94, M95, M96 | monorepo / unbuilt-source users |

## Lanes and file ownership

Ownership is by **file**, so three lanes can edit concurrently without collision. Ownership of
*behavior* is stated per milestone.

| Lane | Owns | Milestones |
|---|---|---|
| A | `src/harness.ts`, `src/preflight.ts`, `src/cli.ts`, `src/vue-sfc.ts` | M87, M88, M93, M94, M95 |
| B | `src/prop-gen.ts`, `src/prop-gen-values.ts`, `src/prop-presets.ts`, `src/measure.ts` | M84, M86, M89 |
| C | `src/analyze.ts`, `src/report.ts`, `src/hints.ts`, `src/isolation.ts`, `src/composition.ts`, `src/shims/` | M85, M90, M91, M96 |

A lane never edits another lane's files. Where a milestone needs a cross-lane value, the **producer
lane** adds the field and the **consumer lane** reads it; the field is specified here so both sides
can be built independently.

### Cross-lane interfaces, fixed up front

1. **`PropSchema.provenance`** (Lane B produces, Lane C consumes). Each synthesized value records how
   it was chosen: `"declared"` (a real literal or union member from the type), `"preset"` (from
   `<stem>.props.tsx`), `"heuristic"` (a name-based special case such as `currencyCode`),
   `"placeholder"` (a generic fill such as `"test"`), or `"contract"` (a value whose truthiness
   imposes a requirement on other props, such as `asChild`). M85 keys its verdict rule on this.
2. **`ComboReport.harnessFault`** (Lane C owns). Set when a combo's failure is attributable to a value
   the harness synthesized rather than to the component. Carries
   `{ propName, value, provenance, evidence }`.
3. **Warning channel on the failure path** (Lane A produces, Lane C renders). M90 requires that CSS
   discovery and alias attribution be emitted as warnings at the moment they are decided, not
   assembled at report time.

---

# Wave 1 — correctness

## M84 — Synthesized prop values are semantically valid

**Lane B.** Owns which value is chosen for a prop. Does NOT own what happens to the verdict when a
synthesized value causes a failure; that is M85.

Closes: commerce-F1, commerce-F1b, commerce-F2, element-plus-F2, element-plus-F4, base-ui-F3,
twenty-F5, calcom-F7, calcom-F8, excalidraw-F7.

### MUST

- A name-based value heuristic that applies to a top-level prop applies identically at every depth of
  a nested object or array element. commerce's control proves the gap: `currencyCode` at top level
  synthesizes `"USD"`, and `label.currencyCode` one level down synthesizes `"text"`.
- A prop whose type or name identifies it as an image source (`src`, `srcSet`, `poster`) synthesizes a
  value that resolves without a network request — an inline `data:` URI. `"test"` is not acceptable: it
  relative-resolves against the harness origin and 404s.
- A prop feeding an identity-keyed collection (an array of objects consumed as rows or items)
  synthesizes stable object identities across renders within a combo, so a component keying a
  `WeakMap` on its own rows does not throw. element-plus's `data:["item"]` produced
  `TypeError: Invalid value used as weak map key`.
- A mixed primitive-and-literal union (`boolean | 'trap-focus'`, `number | 'any'`) synthesizes a member
  of that union.
- A multi-branch union (`string | ReactElement`, `(() => ReactNode) | ReactNode | null`) reports every
  branch it collapsed, and which branch it chose.
- Every synthesized value carries `provenance` per the cross-lane interface above.

### MUST NOT

- Silently drop a prop from synthesis. base-ui's `modal` and `step` were dropped with zero warning,
  sitting next to correctly-flagged degenerate props.
- Emit a value whose only justification is that it type-checks, when the prop's name or type carries a
  stronger signal that is already available.

### Verification

Fixtures per shape: nested `currencyCode`; an image `src`; an identity-keyed row array; both mixed
unions; a three-branch union. Each asserts the synthesized value AND its `provenance`.

---

## M85 — A harness-caused failure is not the component's verdict

**Lane C.** Owns the verdict rule and its disclosure. Does NOT own value selection; that is M84.

Closes: radix-primitives-F3 (adjudicated `major` by the coordinator), element-plus-F2, commerce-F1,
plus the general rule.

The existing rule that a *network request* the harness caused must not be charged to the component is
correct and must be **generalized to renders and crashes**. This is the highest-impact finding of run
2: `npx 120fps ./Separator.tsx` reports `Result: FAIL` on a correct, widely-shipped component because
the harness set `asChild=true` without supplying the single React element child that flag
contractually requires.

### MUST

- A combo whose failure is traceable to a value with
  `provenance: "placeholder" | "heuristic" | "contract"` sets `ComboReport.harnessFault` and does
  **not** count as a component failure.
- A prop whose truthiness imposes a contract on other props (`asChild`, `as`, `render`, and any boolean
  whose `true` branch changes what `children` must be) is either synthesized together with a satisfying
  value for the props it constrains, or excluded from the combo set with a disclosure.
- The report states, per affected combo, which synthesized value caused the fault and what was done
  about it.
- `report.pass` ignores `harnessFault` combos.

### MUST NOT

- Report `FAIL` for a component whose only failing combos are `harnessFault`.
- Silently drop the affected combo. Exclusion is a disclosure, not a deletion.

### Verification

A fixture component with an `asChild`-style slot contract that throws when given non-element children.
Assert `harnessFault` is set, the verdict is not `fail`, and the disclosure names the prop.

---

## M86 — Prop selection keeps the props that matter

**Lane B.** Owns the schema: which props survive the cap, in what order, and what a preset can do.

Closes: ant-design-F1, ant-design-F2, ant-design-F3, chakra-ui-F3, heroui-F1, heroui-F2, base-ui-F4,
shadcn-ui-F4, taxonomy-F4.

Two distinct mechanisms, both verified in source, and both must be fixed:

1. **Generic parameters defeat handler ranking.** `propRank` (`src/prop-gen.ts:1149`) grants Tier-2
   rank via `EVENT_HANDLER_NAME.test(name) && nonUndefined.some((t) => t.getCallSignatures().length > 0)`.
   Through an unresolved generic parameter `getCallSignatures()` returns 0, so real handlers fall to
   Tier-3 declaration order. heroui's polymorphic `Table` buries `onClick` behind Clipboard and
   Composition events while four of its five siblings are fine.
2. **Volume.** ant-design's Button extracts 261 props and taxonomy's 219; `onClick` sits past 32 even
   with correct ranking.

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

### Verification

A fixture with more than 32 props including a required one and an own-referenced `onClick`; a
polymorphic generic component with a handler; a preset naming a truncated prop.

---

## M87 — Vue scenes mount with their slots

**Lane A.** Owns Vue entry generation and SFC scene construction.

Closes: primevue-F5, element-plus-F1.

Two live Vue mount defects, both of which make a correct component look broken:

- primevue `Accordion.vue` crashes on mount with `TypeError: this.$slots.default is not a function`.
- element-plus `button.vue` reports DOM=0 for all eight combos in the combo phase while the scale-probe
  phase reports DOM=2/6/21/51 for the same component. Ground truth: `button.vue`'s root
  `<component :is="tag">` is unconditional, so the combo phase is factually wrong.

### MUST

- A Vue component that reads `this.$slots.default()` or `slots.default?.()` receives a slot function,
  not a value.
- A component whose template has an unconditional root renders a non-zero DOM node count in the combo
  phase.
- When the combo phase and the scale-probe phase disagree about whether anything rendered, the run
  states which phase is believed and why.

### MUST NOT

- Report a render-health disagreement as the final answer when one phase is demonstrably correct.

### Verification

Vue SFC fixtures: an Options-API component calling `this.$slots.default()`; a `<script setup>`
component with an unconditional root; a component whose root sits behind `v-if`.

---

# Wave 2 — reliability

## M88 — Every run terminates and cleans up

**Lane A.** Owns process lifecycle, dev-server teardown, and harness-directory hygiene.

Closes: the taxonomy `EXIT=124` hang, excalidraw-F5, heroui-F4, shadcn-ui-F5, dub-F4, mantine-F6.

The hang is the more serious half and was previously known only as a vitest-only teardown issue. It
reproduces against a real repository on the failure path: taxonomy printed a complete, well-written
fatal error at 18:56:50 and the process was still alive roughly twenty minutes later when an external
timeout killed it. A user sees a correct error and a terminal that never returns.

### MUST

- After a fatal error is printed, the process exits with its documented code within 10 seconds.
- The documented exit-code table holds: `0` pass, `1` verdict failure, `2` setup error. A setup-shaped
  failure never exits `124` and never hangs.
- Harness directories are removed on **every** exit path, including `PASS` / exit 0. excalidraw leaked
  on a passing run, which inverts the previous crash-gated assumption.
- Cleanup finds harness directories at the **workspace member root**, not only the repository root.
  heroui's leaked directory lived at `packages/react/.120fps-harness-*` and was invisible to a
  repo-root check.

### MUST NOT

- Depend on a later, unrelated invocation to sweep a directory the current run created.

### Verification

A test that induces a fatal error after the dev server is up and asserts process exit within the
deadline; cleanup assertions on the pass path, the crash path, and a nested workspace member.

---

## M89 — Prop-delta measurement completes

**Lane B.** Owns the delta pass and its interaction with the frame pump.

Closes: the taxonomy control failure.

Deterministic, reproduced on a quiet machine with the whole fleet idle: taxonomy's `button.tsx`
reaches `prop deltas` and dies with `rerender phase failed on combo 14 of button.tsx: page.evaluate:
Error: frame starvation: rAF fence exceeded 10000ms`. `--no-deltas` produces a clean `Result: PASS` in
4m 8s, so the delta pass alone is at fault. `--no-attribution`, the first remedy the error suggests,
stalls identically.

### MUST

- A component measurable with `--no-deltas` also completes its delta pass, or the delta pass degrades
  to a disclosed partial result rather than failing the run.
- The rAF fence has a bounded, disclosed retry and does not exceed the phase budget silently.
- Any remediation hint for a phase failure names a flag that actually targets the failing phase.

### MUST NOT

- Suggest `--no-attribution` for a failure in the delta phase.

### Verification

Regression test reproducing the delta-phase fence timeout; assert completion or disclosed degradation,
and assert the hint names `--no-deltas`.

---

# Wave 3 — honesty

## M90 — Disclosure survives the failure path

**Lane C.** Owns what reaches the user when a run does not finish.

Closes: ant-design-F5, ant-design-F6, dub-F3, nuxt-ui-F4, shadcn-ui-F3, mantine-F5, calcom-F6.

The tool's internal reasoning is frequently correct and invisible. ant-design's CSS discovery correctly
skips the opt-in `reset.css` and identifies the `cssinjs` runtime — verified by direct probe — and the
user never sees it, because the `Stylesheets:` line lives in the final report block and the run dies
first. dub printed it in 0 of 12 runs.

### MUST

- The stylesheet decision — which file, which discovery layer (`entry` / `candidate` / `fallback` /
  `none`), and its confidence — is emitted as a warning at the moment it is decided, so it survives any
  later failure.
- The `Warnings recorded before this failure:` block appears at **every** throw site. It currently works
  at the harness-timeout, PostCSS, and preflight sites but not at ant-design's esbuild resolve site,
  where a real warning existed and was not printed.

### MUST NOT

- Assemble a disclosure only at report-construction time when the value is known earlier.

### Verification

A test per throw site asserting the warnings block is present and carries the CSS decision.

---

## M91 — Modes and flags disclose identically

**Lane C.** Owns parity between what a mode promises and what it prints.

Closes: preact-app-F2, primevue-F2, commerce-F3, mantine-F4, element-plus-F3.

`--explain-props` is the tool's own cheapest and most-recommended first probe, and it is the mode that
hides the warning that matters most. preact-app's full run discloses
`next.config.js aliases react-dom to "preact/compat" ... this measurement runs the real react-dom, not
what your app ships` — the exact silent-mismeasurement warning — and the dry run says nothing.

### MUST

- `--explain-props` emits every warning the full run would emit for the same component.
- Matrix mode carries the `[props excluded]` mark and `disclosureReason` in both its cell table and its
  JSON, as combo mode already does.
- The server-boundary import walk follows JSX composition at least one hop, so a sync component
  composing async server components is gated. commerce's `app/page.tsx` passes `--explain-props` clean
  and then dies with an obscure `__dirname is not defined`, while targeting the same async children
  directly produces a correct rejection.

### MUST NOT

- Let a dry run report a clean result where the real run refuses, or the reverse.

### Verification

Parity test comparing the warning set of `--explain-props` and a full run over the same fixtures; a
matrix-mode disclosure test; an RSC one-hop fixture.

---

## M92 — Every printed message is true of the run

**Cross-lane sweep, run last, single worker.** Each lane fixes messages in its own files first; this
milestone is the final audit.

Closes: dub-F2, twenty-F3, element-plus-F3, excalidraw-F6, mantine-F2 (text half), calcom-F3.

Confirmed false statements:

- dub: `src/styles.css contains no rules of its own (only comments and imports)` — the file holds three
  `@tailwind` at-rules and zero comments or imports.
- twenty: a warning naming three files as `resolved to no file the harness can serve` when two of them
  resolve fine and only one is missing.
- element-plus: `if the component has typed props, extraction may have failed` for a shape that is
  **deliberately out of scope** by ADR 0002 — a design decision presented as a possible malfunction.
- excalidraw: a stylesheet pick disclaiming `no evidence` while landing on the demonstrably correct
  design-token root.

### MUST

- Every message states something true of the run that produced it.
- A deliberate scope exclusion is worded as an exclusion, never as a possible failure.
- A message naming files individually reports each file's actual status.

### Verification

Each false message above gets a regression test asserting the corrected text against a fixture that
reproduces its trigger.

---

# Wave 4 — resolution and unbuilt source trees

## M93 — Path aliases resolve every shape TypeScript accepts

**Lane A.** Owns alias construction and its warnings.

Closes: mantine-F1 (the run's only blocker), mantine-F2, mantine-F3, the material-ui alias warning,
chakra-ui-F1.

`buildPathAliasEntry` (`src/harness.ts:2940`) handles only a trailing `/*` on **both** sides. Targets
with a non-trailing wildcard are discarded:

- mantine `"@mantine/*": ["./packages/@mantine/*/src"]` — every full run dies on
  `Failed to resolve entry for package "@mantine/hooks"`.
- material-ui `"@mui/icons-material/*": ["./packages/mui-icons-material/lib/*.mjs"]` — the target
  resolves to **10,751 real files** and is thrown away anyway.

`ALIAS_SHAPE_WARNING` (`:2851`) then says `one side has a "*" and the other does not`, which is false
for both — each side has exactly one. The source comment at `:2946` claims such a shape
`has no Vite alias that means the same thing`; that is also wrong. Vite supports a regex `find` with
`$1` capture replacement, and the function already builds a `RegExp` for the trailing case.

### MUST

- A `paths` entry with exactly one `*` on each side builds a working alias regardless of where the `*`
  sits in the target, via a capture-group replacement.
- `ALIAS_SHAPE_WARNING` fires only when the wildcard counts genuinely differ, and its text describes the
  actual mismatch.
- The workspace-root `vite.config` is consulted as a disclosed fallback layer when a bare specifier
  fails to resolve through the member's own config. chakra's root `vite.config.ts` carries the alias
  that makes `@chakra-ui/react` resolvable and it is still never read.
- An alias that rescues a run is attributable: the warning names the config it came from.

### MUST NOT

- Discard a resolvable alias target.
- Infer "type-only" for a package that has an unbuilt `dist/` but live source. mantine's
  `@mantine/hooks` is excluded as `almost certainly type-only` while `Tabs.tsx:2` uses it as runtime
  hooks.

### Verification

Fixtures for mid-path (`./packages/*/src`), extension-suffixed (`./lib/*.mjs`), genuinely mismatched
counts, and a workspace-root vite.config alias. Existing `test/unit/tsconfig-aliases.test.ts` contracts
must keep passing.

---

## M94 — Bundler failures surface as 120fps errors

**Lane A.** Owns error presentation on the build path. Does NOT own detecting missing build output or
naming its command; that is M95.

Closes: shadcn-ui-F1, shadcn-ui-F2, dub-F1, twenty-F2, chakra-ui-F1, nuxt-ui-F3 (shape check),
calcom-F2, calcom-F3.

Four repositories surface multi-frame Vite/PostCSS traces containing **120fps's own `node_modules`
paths**. shadcn-ui is the worst case because it is the tool's best case: `npx 120fps ./button.tsx` on
shadcn's own button emits ten frames of PostCSS internals. dub is sharper still — the tool emits a
warning saying an import was `excluded from the pre-bundle` and then crashes on that same import.

### MUST

- A Vite, PostCSS, or esbuild failure is caught and re-presented as a 120fps error naming the
  unresolvable target, the importer that reached it, and a remedy.
- No error printed to the user contains a path inside 120fps's own installation.
- A warning claiming an import was excluded is true: that import does not subsequently reach the
  bundler.

### MUST NOT

- Print a raw bundler stack trace.

### Verification

Fixtures reproducing each of the four shapes; assert the message names the target and the importer, and
assert absence of any `node_modules/.pnpm/vite@` substring in user-facing output.

---

## M95 — Missing build output degrades, or names its command

**Lane A.** Owns detection of absent build artifacts and the remedy text.

Closes: nuxt-ui-F1, nuxt-ui-F2, shadcn-ui-F1, twenty-F2, ant-design-F7, dub-F1, calcom's unbuilt
packages.

The decided policy: degrade and measure wherever possible; where a component genuinely cannot resolve
without the repository's own build, fail fast naming the exact command.

Corpus cases: nuxt-ui's `tsconfig.json:2` extends `./.nuxt/tsconfig.json` which does not exist, and
`src/runtime/index.css:1` imports the `#build/ui.css` virtual module; ant-design's every full run dies
on a gitignored generated `components/version/version.ts`; shadcn's `shadcn/tailwind.css` resolves
through an absent `dist/`; twenty and dub have workspace packages whose `exports` point at absent
`dist/`.

### MUST

- A target pointing at absent build output is skipped with a warning naming it, and the run continues
  when the component can still render without it.
- When it cannot, the error names the exact command for that repository's toolchain (`nuxi prepare`, the
  package's own `build` script) rather than a generic instruction.
- A broken tsconfig `extends` chain is reported with the missing path, and its downstream consequence is
  connected to it. nuxt-ui currently reports the broken chain AND separately reports 0 props on all five
  candidates, never joining the two.

### MUST NOT

- Require a build step silently.
- Report an empty prop schema without naming the resolution failure that caused it.

### Verification

Fixtures: a package whose `exports` points at an absent `dist/`; a tsconfig extending a missing file; a
virtual-module import. Assert degrade-with-warning where renderable and command-naming where not.

---

## M96 — Bundled shims match their real module surface

**Lane C.** Owns `src/shims/`.

Closes: calcom-F2.

cal.com's DatePicker hard-fails at build because 120fps's own `dist/shims/next-navigation.js` is
missing the `ReadonlyURLSearchParams` export that `useCompatSearchParams.tsx:3` imports. This is a
defect in the tool's own code, not in the target repository.

### MUST

- Every shim exports every named export the module it replaces is documented to provide, for the version
  range the tool claims to support.
- A component importing a named export a shim does not provide gets an error naming the shim, the
  missing export, and `--no-shims`.

### Verification

A test enumerating each shim's export surface against the real module's public API; a fixture importing
`ReadonlyURLSearchParams`.

---

## Rules for all thirteen

- Anchor every claim to `file:line` read from **current** source. Line numbers in this map were read on
  2026-08-20 and may move.
- Every spec lists the run-2 finding IDs it closes, so the report and the specs stay traceable.
- Every acceptance criterion must be checkable against a **fixture**, not against a cloned repository.
  The twenty repositories are a manual re-verification corpus, not CI.
- Follow the repo's TDD loop: spec, then failing tests, then implementation, then green, then harden.
- A milestone whose scope grows during implementation is **split**; new scope becomes a new milestone.

## Out of scope, by explicit decision

- Solid support (solid-ui), Yarn PnP resolution (pnp-app), and mounting through `preact/compat`
  (preact-app). All three refuse cleanly and accurately today; that counts as correct behavior. Only
  their message quality is in scope, under M92.
- Re-weighting the corpus. Run 2's corpus is 17 of 20 workspace monorepos and 11 of 20 component
  libraries, with no plain Vite SPA, no Remix or Astro, and no Vue application. That gap is recorded in
  `REPORT.md` and is a corpus decision, not a milestone.
