---
kind: milestone
status: approved
tests:
  - test/unit/page-errors.test.ts
  - test/unit/measure.test.ts
  - test/unit/compare-worktree-prune.test.ts
---

# M70: failure diagnosability plumbing

## Goal

A failure on an unconventional repo currently surfaces as a generic 30s `HARNESS_READY_TIMEOUT`
with no cause: a CSS 404 or a preprocessor 500 kills module evaluation silently, three of four
`settleStyles` call sites discard the settled boolean so a font-timeout runs proceed unflagged,
and a hard-killed `--compare` run leaves `.git/worktrees/<name>` registered forever. This
milestone makes each of these three failures name themselves.

## Scope

### 1. Network-failure capture (`src/page-errors.ts`)

`attachPageErrorCapture` (`src/page-errors.ts:65`) gains two more `page.on` listeners feeding the
same `session`/`segment` buckets `pageerror` and `console` already write to (`src/page-errors.ts:74-83`):

- `requestfailed`: records `` `request failed: ${method} ${url}` ``, with `` ` (${errorText})` ``
  appended when `request.failure()` returns one.
- `response` with `status() >= 400`: records `` `response ${status}: ${method} ${url}` ``, method
  read from `response.request()`.

Both go through the same `record()` calls as the existing two listeners, so the existing
20-distinct cap, `(×N)` repeat counting, and drop counting (`src/page-errors.ts:32-63`) apply to
them unchanged, and no new field is added to `PageErrorDrain`. Neither listener sets
`segmentFatal`: a 404'd image is not proof a render crashed, exactly as a React/Vue
`console.error` dev warning already is not (`src/page-errors.ts:5-8`). Because `errors`,
`summary()`, and `drain()` already surface every session-bucket entry, `enrichTimeoutError` and
`gotoWithErrorContext` (`src/page-errors.ts:145-179`) name a 404'd URL in a timeout message with
no changes of their own: extending what feeds the bucket is sufficient.

### 2. Settle-gate warnings (`src/measure.ts`, `src/explorer.ts`, `src/react-profiler.ts`, `src/analyze.ts`, `src/compare.ts`)

New shared helper in `src/measure.ts`, next to `FONT_SETTLE_WARNING` (`src/measure.ts:276`):

```ts
export function reportFontSettle(settled: boolean, onWarning?: (warning: string) => void): void
```

Calls `onWarning?.(FONT_SETTLE_WARNING)` when `settled` is `false`; otherwise a no-op. One
wording, one place it is spelled.

Three call sites currently discard `settleStyles`'s return value; each is changed to capture it
and call `reportFontSettle`:

- `enterHarness` (`src/measure.ts:347-374`): `reportFontSettle(await settleStyles(page, harness), options.onWarning)`. `options` is `HarnessSessionOptions`, which already declares `onWarning` (`src/measure.ts:331-338`) — the field exists but was never read by this function.
- `explore`'s `enter` closure (`src/explorer.ts:467-485`): same pattern, reading the already-present `options.onWarning` (`ExploreOptions.onWarning`, `src/explorer.ts:97`).
- `runReactAnalysis` (`src/react-profiler.ts:627-685`): `ReactAnalysisOptions` (`src/react-profiler.ts:548-559`) gains `onWarning?: (warning: string) => void`, threaded the same way.

Two of `enterHarness`'s own callers construct a fresh `HarnessSessionOptions` literal that omits
`onWarning` even though their own outer options carry one: `measureMount`'s `enter`
(`src/measure.ts:1347-1351`) and `measureRerender`'s `enter` (`src/measure.ts:1208-1212`). Both
gain `onWarning: options.onWarning`. `runHarnessSession`'s `enter` (`src/measure.ts:708-712`)
already spreads `...options` into the call and needs no change.

`compareAgainstRef`'s two `enterHarness` calls, one per side (`src/compare.ts:246-254`), gain a
local deduplicating `onWarning` (`src/compare.ts:192-197`) that pushes onto `CompareReport.warnings`:
the working and reference sides settle independently, and either can fail on its own.

`analyze.ts` wiring differs by call site because of a pre-existing ordering constraint:

- `measureMount` and `measureRerender` (`src/analyze.ts:1401-1421`) and `explore`
  (`src/analyze.ts:1430-1440`) already receive `onWarning` — the run's shared, deduplicating
  closure (`src/analyze.ts:2034-2038`) that feeds `runWarnings`, which `ctx.attachHarnessContext`
  flushes into `report.warnings` (`src/analyze.ts:2092-2095`). All three calls in `runComboMode`
  run before `ctx.attachHarnessContext(report)` (`src/analyze.ts:1494`), so a font-settle warning
  raised in any of them reaches the report through the existing path with no new wiring beyond
  passing the boolean through.
- `runReactAnalysis` (`src/analyze.ts:1517-1533`) runs *after* that same
  `ctx.attachHarnessContext(report)` call within `runComboMode`. Routing its warning through the
  shared `onWarning`/`runWarnings` closure would push into an array that has already been flushed
  and is never read again for this report: the warning would be silently dropped, not merely
  late. `runComboMode`'s control flow is out of scope to reorder here, so this call site instead
  gets a dedicated `onWarning` that writes straight onto the already-existing `report` object,
  deduplicated against what `report.warnings` already holds:

  ```ts
  onWarning: (warning) => {
    if (!(report.warnings ?? []).includes(warning)) {
      report.warnings = [...(report.warnings ?? []), warning];
    }
  }
  ```

  This reuses `FONT_SETTLE_WARNING` verbatim; it does not invent new wording, and it is
  order-independent with respect to `ctx.attachHarnessContext`.

### 3. Worktree prune on `--compare` (`src/compare.ts`)

New exported, best-effort function, mirroring `sweepStaleHarnessDirs` /
`sweepStaleTmpDirs`'s swallow-everything shape (`src/harness.ts:990-1029`):

```ts
export function pruneStaleWorktrees(repoRoot: string): void
```

Runs `git(["worktree", "prune"], repoRoot)` inside a `try`/`catch` that discards any failure
(corrupted `.git`, no `git` on `PATH`, `repoRoot` not a repo). Called once, at the start of the
main `try` block in `compareAgainstRef` (`src/compare.ts:206`), before `git worktree add`: a
SIGKILL or OOM on a prior `--compare` run leaves `<repo>/.git/worktrees/<name>` registered with
no working directory behind it, and nothing currently sweeps it. `prune` clears any such
dangling registration so it never accumulates across runs and never collides with a fresh
`worktree add`.

## Does NOT include

- Retrying or working around a 404/500 the harness hits — it is only named, not recovered from.
- A new field on `PageErrorDrain`, or any change to `drain()`/`summary()`/`errors`/`fatal`
  semantics beyond more messages flowing into the same buckets.
- Reordering `runComboMode`'s `ctx.attachHarnessContext(report)` call.
- Wiring `onWarning` through `src/isolation.ts`'s callers of `runHarnessSession`
  (`measureChurn`, `measureMemory`, `measureStrictMode`): none pass one today, `isolation.ts` is
  outside this milestone's file ownership, and `enterHarness`'s new `options.onWarning?.(...)`
  call is a no-op when the caller supplies none.
- A periodic or startup-time worktree sweep independent of `--compare`; `pruneStaleWorktrees`
  only runs on the `--compare` path, matching where the leak is introduced.
- Any change to `src/harness.ts`, `src/prop-gen.ts`, `src/project-model.ts`, or `src/index.ts`
  (owned by a concurrent lane). No barrel export is added for `reportFontSettle` or
  `pruneStaleWorktrees`; both are consumed via direct module imports.

## Acceptance

- A component whose CSS import 404s: the timeout error message names the 404'd URL.
- A component whose CSS import triggers a preprocessor 500: same.
- `capture.drain().fatal` stays `false` when the only events captured are network failures.
- A run whose harness-entry, explore-phase, or react-analysis-phase font settle times out gets
  exactly one `FONT_SETTLE_WARNING` per phase that actually failed, present in `report.warnings`.
- `--compare`, run twice in a row after the first run is hard-killed between `git worktree add`
  and cleanup, does not fail on a stale worktree registration.
