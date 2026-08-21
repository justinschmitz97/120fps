---
kind: milestone
status: draft
tests:
  - test/unit/css-decision-survives-failure.test.ts
  - test/unit/bundler-error-presentation.test.ts
---

# M90: Disclosure survives the failure path

## Purpose

`analyze()`'s internal reasoning is frequently correct and invisible. ant-design's CSS discovery
correctly skips the opt-in `reset.css` and identifies the `cssinjs` runtime, verified by direct
probe — and the user never sees it, because the `Stylesheets:` line lives in the final report block
and the run dies first (an unrelated `esbuild` resolve failure on a gitignored generated file). dub
printed it in 0 of 12 runs, for the same structural reason. This milestone makes the stylesheet
decision a fact recorded at the moment it is decided, not at the moment a report is assembled, so it
survives any later failure — and closes a second, distinct gap where the crash-path warnings block
itself failed to appear even though a real warning had already been recorded. This holds across all
three failure-arrival surfaces `src/harness.ts`'s `presentBundlerFailure` documents (`analyze()`'s own
guarded try block covers surfaces 1 and 2; cli.ts's `process.on("unhandledRejection")` handler is
surface 3, reached by a detached async rejection with no access to `analyze()`'s own closure at all —
ant-design's live proof: the gitignored-file diagnosis reached surface 3 correctly, but the warnings
block that should have accompanied it did not, until surface 3 gained its own path to the same
accumulated warnings).

Closes: ant-design-F5, ant-design-F6, dub-F3, nuxt-ui-F4, shadcn-ui-F3, mantine-F5, calcom-F6.

## Contract

### MUST

- The stylesheet decision — which file, which discovery layer (`entry` / `candidate` / `fallback` /
  `none`), and its confidence — is emitted as a warning at the moment it is decided, so it survives
  any later failure.
- The `Warnings recorded before this failure:` block appears at **every** throw site inside
  `analyze()`'s guarded try block, including one whose thrown value is not an `instanceof Error`
  (the shape ant-design's `esbuild` resolve failure took).
- The same block appears at the async-rejection surface (`resolveFatalProcessError`, `src/cli.ts`)
  too, built from whatever this run had accumulated before the detached rejection fired — not only at
  the two surfaces inside `analyze()`'s own call stack.

### MUST NOT

- Assemble a disclosure only at report-construction time when the value is known earlier.
- Print the stylesheet decision twice on a passing run (once as `Stylesheets:`, once inside a generic
  `Warnings:` list) — the crash-path mechanism must not leak into the success path's output.

### Invariants

- The stylesheet decision computed for the crash-path warnings block is byte-identical to the one
  `formatStylesheetsLine` would print in a completed report for the same run: both read the same
  `CssReport`, computed once.
- A preflight hard rejection (`PreflightHardRejectionError`) is unaffected: it remains a standalone,
  complete diagnosis with no warnings stacked onto it (pre-existing M78/M79 rule, unchanged by this
  milestone).

## Design

`resolveCssFiles`/`cssReport` construction (`src/analyze.ts`) already runs once, early, well before
`preflight` and `harness: building` — both of `analyze()`'s later throw sites. Right after `cssReport`
is built, `formatStylesheetsLine(cssReport)` (`src/report.ts`, newly exported) is computed once into
`cssDecisionWarning: string`. This line is **not** appended to `runWarnings` (which becomes
`report.warnings` on a successful run and would duplicate the dedicated `Stylesheets:` line there);
it is threaded only into the outer `catch` block's accumulation.

The catch block's accumulation changes from:

```ts
if (err instanceof Error) {
  const carried = (err as Error & { warnings?: string[] }).warnings ?? [];
  const combined = [...new Set([...runWarnings, ...carried])];
  if (combined.length > 0) throw new Error(err.message + formatAccumulatedWarnings(combined), { cause: err });
}
throw err;
```

to always folding in `cssDecisionWarning` and always re-presenting, regardless of the thrown value's
prototype chain:

```ts
const carried = err instanceof Error ? ((err as Error & { warnings?: string[] }).warnings ?? []) : [];
const combined = [...new Set([cssDecisionWarning, ...runWarnings, ...carried])];
const message = err instanceof Error ? err.message : String(err);
throw new Error(message + formatAccumulatedWarnings(combined), { cause: err });
```

Because `cssDecisionWarning` is always a non-empty string (every `CssReport.layer`, including
`"none"` and `"disabled"`, formats to a real sentence), `combined` is now never empty, so the
`if (combined.length > 0)` gate is removed rather than left dead: every throw that reaches this
catch (other than the `PreflightHardRejectionError` early return, unchanged) now gets the block. This
is also the fix for ant-design-F5/bullet 2: the previous `if (err instanceof Error)` guard silently
dropped accumulation for any thrown value that failed that check — plausible for a raw esbuild/Vite
build failure surfacing through a code path this milestone does not otherwise touch — and is now
unconditional.

`formatAccumulatedWarnings` moves from a closure inside `analyze()` to a module-level function
(exported so `src/cli.ts` can reuse it too — see below), so `explainProps` (M91's parity fix) can
reuse the identical formatting without duplicating it.

**Surface 3: the async-rejection handler has no closure to read.** `resolveFatalProcessError`
(`src/cli.ts`) runs on `process.on("unhandledRejection")`'s own call stack, entirely outside
`analyze()`'s function scope — it cannot read `runWarnings` or `cssDecisionWarning` by any form of
closure, and `cli.ts` already imports `analyze.ts` (not the reverse), so `analyze.ts` importing
anything back from `cli.ts` would be a cycle. The fix mirrors the existing `currentRunProjectRoot`
precedent (M92, set independently by `cli.ts`'s own loop before each component, since it can compute a
project root without needing anything from inside the run) but cannot copy it exactly, because a
project root is knowable in advance and warnings are not — they are discovered *during* the run.
`AnalyzeOptions` gains `onWarning?: (warning: string) => void`, the same external-callback shape
`onProgress` already uses: `cssDecisionWarning` is reported through it the moment it is computed, and
the internal `onWarning` closure reports every warning through it too, at the same point it dedupes
into `runWarnings` (so the external view and `runWarnings` never diverge). `cli.ts`'s `runOne` wires
`onWarning: pushCurrentRunWarning`, a new module-level accumulator with the same lifecycle as
`currentRunProjectRoot` (reset before each component, cleared after). `resolveFatalProcessError` reads
it as a fourth, defaulted parameter (`warnings: readonly string[] = currentRunWarnings`, matching
`projectRoot`'s own defaulting) and appends `formatAccumulatedWarnings` to the diagnosed message —
after diagnosis, not before, so a remedy like the gitignored-file command still leads.

## Open questions

None.

## Verification

- A synthetic throw inside the guarded try block (any shape, `instanceof Error` or not) produces a
  message containing `formatStylesheetsLine`'s exact text for the run's `cssReport`, for each of the
  `entry` / `candidate` / `fallback` / `runtime` / `none` / `disabled` layers.
- A `PreflightHardRejectionError` throw still produces zero stacked warnings (regression: existing
  `test/unit/harness-crash-warnings.test.ts` "a preflight hard rejection is not compounded" test).
- A successful (non-throwing) run's `report.warnings` does not contain the stylesheet decision text,
  and its `Stylesheets:` line prints exactly once.
- A throw whose value is a plain object (not `instanceof Error`) still produces a well-formed message
  with the accumulated-warnings block appended (regression test for ant-design-F5's root cause).
- Surface 3 (`resolveFatalProcessError`): warnings pushed via `pushCurrentRunWarning` before a
  synthetic rejection appear in the resolved output's `Warnings recorded before this failure:` block,
  with identical wording to surfaces 1/2; the diagnosed message (e.g. the gitignored-file remedy)
  still leads, with the block trailing it; nothing accumulated produces no block at all (unchanged
  from before this fix — a run with nothing to disclose prints nothing extra). Source-level checks
  confirm `analyze.ts` reports `cssDecisionWarning` and every new `runWarnings` entry through
  `options.onWarning`, and that `cli.ts`'s `runOne` wires `onWarning: pushCurrentRunWarning` into its
  `analyze()` call — the same unit/e2e boundary as the rest of this milestone: exercising the callback
  through a live `analyze()` run needs a real browser and dev server, out of proportion to this fix.
