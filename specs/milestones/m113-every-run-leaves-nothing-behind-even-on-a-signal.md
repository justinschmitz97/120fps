---
kind: milestone
status: draft
tests:
  - test/unit/signal-teardown-removes-harness-dirs.test.ts
  - test/unit/harness-dir-removal-retries-and-discloses.test.ts
  - test/unit/stale-sweep-discloses-what-it-removed.test.ts
  - test/unit/signal-teardown-sweeps-before-any-pool-exists.test.ts
---

# M113: Every run leaves nothing behind, even on a signal

Lane A (`src/cli.ts`, `src/harness.ts`), wave 1, after M111 in the lane A sequence
(`specs/milestones/M107-M117-MAP.md`). No other lane edits these two functions.

## Purpose

A developer who presses Ctrl-C, or whose CI runner sends SIGTERM, gets the shell's exit code for that
signal and an untouched working tree: no `.120fps-harness-*` directory in the project root or in the
member root of the measured component, on Windows, with Chromium and the Vite dev server still live
at the moment of the signal. When a removal still cannot succeed, the run says so, naming the
directory and the reason, and the next run says what it swept.

Closes: base-ui-R1 = CL-base-ui-2 = CL-generic-12 (one blocker, three evidence rows for the same
defect; intermittent, 1 of 2 attempts; self-healing on the next run in the same root).

Run-5 evidence: `C:\Projekte\120fps-fieldtest\EVIDENCE.md:57` (merged confirmed row), `:109`
(root-cause table), `:146`, `:251-252` (claim rows), `:265` (heroui-R1 falsifier: a wrapper
`taskkill /F` delivers no signal, so a hard kill does not exercise this path),
`C:\Projekte\120fps-fieldtest\verify\regression-base-ui.md:1-72` (five labelled attempts, root cause,
falsifiers), `C:\Projekte\120fps-fieldtest\remediation\cluster-briefs.md:164-182` (G7).

## Root causes (verified)

Line numbers are this worktree (`C:\Projekte\120fps-m107`, branch `feat/m107-run5-remediation`), and
they match the map except where noted.

1. `src/harness.ts:275` — `sweepActiveHarnessDirs` (`:271-281`) calls
   `fs.rmSync(dir, { recursive: true, force: true })` with no `maxRetries`/`retryDelay`; neither
   option appears anywhere in `src/`. On Windows an open handle makes that call throw
   EBUSY/EPERM/ENOTEMPTY on the first attempt, and there is no second attempt.
2. `src/harness.ts:276-278` — the `catch {}` around it swallows the error ("Best-effort: the process
   is already on its way out"), so a removal that failed is indistinguishable from one that had
   nothing to remove. The verifier proved the failure by mtime: `.pid`, `entry.tsx`, `index.html` and
   the directory all carried the creation timestamp, ruling out "swept, then recreated".
3. `src/cli.ts:118` — `abortRun` (`:109-141`) runs `(hooks.sweep ?? sweepActiveHarnessDirs)()` before
   `closePoolsBounded` at `:138`, at the one moment Chromium, the Vite dev server and its esbuild
   workers still hold handles on `entry.tsx`, `index.html` and the directory itself. The map cites
   `src/cli.ts:112-118`; the sweep call is `:118` and `abortRun` opens at `:109`, and the map's
   `:109-143` overshoots the function by two lines.
4. No site retries after the pools have closed. The signal handlers
   (`src/cli.ts:193-199`, `registerTerminationHandlers`) reach `abortRun` and nothing else; exit 143
   in the verifier's log is `terminationExitCode("SIGTERM")` (`src/cli.ts:94-96`, `128 + 15`), which
   proves the handler ran and the sweep was called. Delivery is fine; the removal is what failed.
5. `src/harness.ts:3762` — the next-run sweep (`sweepStaleHarnessDirs`, `:3738-3780`) removes through
   the same retry-less default (`:3743`) and reports only the failures
   (`HARNESS_DIR_UNREMOVABLE_WARNING`, `:3730-3736`, pushed at `:3765`). A leftover it removed
   successfully disappears with no record, so `base-ui-R1-verify-sweep` (exit 0, leftover gone) left
   the user no evidence that the previous run's directory had ever been there.

## MUST

### Lane A (`src/cli.ts`, `src/harness.ts`)

- A1 A run stopped by SIGINT, SIGTERM or SIGHUP while a browser and a dev server are live exits with
  130, 143 or 129 and leaves no `.120fps-harness-*` directory anywhere under the project root:
  `ls -d **/.120fps-harness-*` finds nothing and `git status --porcelain` in the measured repository
  is empty, on five of five attempts on Windows.
- A2 When the pre-close removal leaves a directory behind because Chromium or the dev server still
  holds a handle, that directory is gone before the process exits, including a directory created
  after the pre-close removal ran: at the moment of exit no `.120fps-harness-*` remains under the
  project root.
- A3 A removal that fails with a busy or permission error is retried until it succeeds or until 1 s
  of attempts per directory is spent (at least 5 attempts); a single EBUSY/EPERM/ENOTEMPTY never ends
  the attempt. With every outstanding directory counted, the post-close removal still returns inside
  2 s, well under `FATAL_EXIT_WATCHDOG_MS` (`src/cli.ts:28`, 8000 ms).
- A4 A directory that survives the last attempt is printed once on stderr, naming the path as the
  user sees it (relative to the project root) and the error code, and the exit code stays the
  signal's code. Silence means the disk is clean.
- A5 The next run's `.pid`-marker sweep reports what it removed: one line per removed directory
  naming the path relative to the project root and why it was stale ("its owner process is gone",
  "unmarked and older than the age gate", "its owner stopped heartbeating"). The line reaches the
  terminal warnings, `warnings` in `--json`, and the markdown report, through the array that already
  carries the sweep's failure warnings (`src/harness.ts:3379-3380`, `:3592`). A sweep that removed
  nothing prints nothing.
- A6 The next-run sweep retries a busy removal under the same budget as A3, so
  `HARNESS_DIR_UNREMOVABLE_WARNING` names a directory only after the retries are spent, and the whole
  stale sweep returns within 2 s no matter how many leftovers are locked.

## MUST NOT

- Exit later than 10 s after the signal because of the removal. `FATAL_EXIT_WATCHDOG_MS`
  (`src/cli.ts:28`, 8000 ms) still owns the deadline for the whole abort, and the retry budget fits
  inside it; a removal that keeps failing loses to the deadline and is reported by A4, never waited
  on.
- Drop the pre-close sweep, or make the post-close sweep the only one: the removal runs twice, once
  before the pools close (unchanged, the "pools never settle" fallback) and once after the bounded
  close returns, because a pool close that never settles must still leave the disk clean.
- Delay the start of a run: the next-run sweep's retries stay inside the A3 budget per directory and
  never change the build, mount or explore phase timings a run reports.
- Remove a directory whose `.pid` marker names a live process, or the current process's own
  directory (`src/harness.ts:3751-3760`, M101).
- Change the exit code, the verdict, or any measured number because a sweep removed or failed to
  remove something. A swept leftover is a warning, never a failure.
- Print a removal report when nothing was removed.
- Add asynchronous removal work to the `process.on("exit")` path (`src/harness.ts:287`): that handler
  permits synchronous work only, so the retries stay synchronous.

## Interfaces needed

None. Both sites are lane A files, and the removal report reuses the `sweepWarnings` array that
`src/harness.ts:3379-3380` already threads into `buildWarnings` at `:3592`. Conflict C11 in
`M107-M117-MAP.md`: M117's warning collector (lane C) deduplicates `report.warnings` and lands after
every warning producer; A5's line is ordinary warning text and needs no new channel. Conflict C12:
A2's abort path (`src/cli.ts:109-141`) is disjoint from M111's, M115's and M117's CLI edits.

## Verification

Unit tests (`vitest run <files> --maxWorkers=2`), directories built under `os.tmpdir()` the way
`test/unit/harness-dir-cleanup.test.ts` already builds them; no new fixture directory is needed, and
`fixtures/css-stall/` (its build stalls, so handles are still open at a kill point) is the fixture the
signal-path test drives.

- A1, A2 — `test/unit/signal-teardown-removes-harness-dirs.test.ts`: `abortRun` with injected pools
  and an injected sweep records the call order and asserts a sweep before the pool closes, a second
  sweep after both `closeAll` calls resolve, and exactly one `exit` with the code it was given; a
  pool whose `closeAll` never resolves still produces both sweeps or the deadline exit, and the
  existing order assertions in `test/unit/killed-run-cleanup.test.ts:119-134` stay green.
- A3, A4, A6 — `test/unit/harness-dir-removal-retries-and-discloses.test.ts`: an injected remover
  that throws `EBUSY` for the first N calls and then succeeds proves the retry; one that always
  throws proves a single stderr line naming the relative path and `EBUSY`, and proves no throw
  escapes; a directory holding a file opened with `fs.openSync` proves the real `rmSync` path removes
  the directory once the test closes the handle.
- A5 — `test/unit/stale-sweep-discloses-what-it-removed.test.ts`: three directories (dead-pid marker,
  no marker and older than the age gate, live-pid marker with a stale heartbeat) produce three
  removal lines naming their relative paths and their reasons; a directory marked with
  `process.pid` and a fresh heartbeat produces no line and is still there; an empty root produces no
  line.

Corpus, through a scratch dist built from this worktree
(`node node_modules/typescript/bin/tsc --outDir <scratch>`, `node_modules` junction, removed
non-recursively afterwards). The repro is `EVIDENCE.md:57`, verbatim:

```
node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd /e/repositories/base-ui --out C:/Projekte/120fps-fieldtest/logs/regression-base-ui --label base-ui-R2-kill2 --timeout 1500 -- packages/react/src/number-field/root/NumberFieldRoot.tsx --samples 5 --max-combos 4 --explore-budget 60 --no-deltas & PID=$!; sleep 6; kill -TERM $PID
```

Expected after the fix, on five consecutive attempts (the defect is a race that reproduced 1 of 2
times, so a single green attempt proves nothing): the wrapper's meta reports exit 143;
`ls -d /e/repositories/base-ui/.120fps-harness-* /e/repositories/base-ui/packages/react/.120fps-harness-*`
prints `No such file or directory` for both within 10 s of the kill; and
`git -C /e/repositories/base-ui status --porcelain` is empty. Use msys `kill -TERM` on the bash job
id, never on the Windows pid from the `.pid` marker: `base-ui-R1-verify-killcli` recorded
`kill: (37756) - No such process` for the latter, and a wrapper `taskkill /F` (heroui-R1) delivers no
signal at all, so neither exercises this path.

A sixth attempt, run to completion on the same root, prints no removal line (nothing was left behind)
and reaches its report. One unaffected repo still reaches a report — `EVIDENCE.md:97`, whose `--out`
is written there abbreviated and expands to `C:/Projekte/120fps-fieldtest/logs/shadcn-admin`:

```
node run120.mjs --cwd /e/repositories-run5/shadcn-admin --out .../logs/shadcn-admin --label toolbar-remedy --timeout 1500 -- src/components/data-table/toolbar.tsx --samples 5 --max-combos 4 --explore-budget 60 --no-deltas
```

Expected after the fix: exit 0, the run reaches its report at
`C:/Projekte/120fps-fieldtest/logs/shadcn-admin/toolbar-remedy.log`, `warnings` contains no
`leftover harness directory` text and no A5 removal line, and
`ls -d /e/repositories-run5/shadcn-admin/.120fps-harness-*` prints `No such file or directory`.

Pass-gate to protect: shadcn-admin-F3 (`EVIDENCE.md:157`) — a leftover directory from an externally
interrupted run is still removed by the next ordinary run, now with A5's line naming it.

`tsc --noEmit` clean; `test/unit/harness-dir-cleanup.test.ts`, `test/unit/harness-sweep.test.ts`,
`test/unit/harness-dir-writability.test.ts`, `test/unit/harness-crash-warnings.test.ts` and
`test/unit/killed-run-cleanup.test.ts` stay green (baseline failures excepted).

### Lane A evidence (2026-09-03)

Tests: `node node_modules/vitest/vitest.mjs run test/unit/signal-teardown-removes-harness-dirs.test.ts
test/unit/harness-dir-removal-retries-and-discloses.test.ts
test/unit/stale-sweep-discloses-what-it-removed.test.ts --maxWorkers=2` →
`Test Files 3 passed (3) / Tests 16 passed (16)`.
The lane's neighbours (`exit-watchdog`, `harness-crash-warnings`, `harness-dir-cleanup`,
`harness-dir-writability`, `harness-sweep`, `killed-run-cleanup`,
`lane-a-m87-m88-m93-m94-m95-harden`, `tsconfig-export-harden`) →
`Test Files 8 passed (8) / Tests 98 passed | 1 skipped (100)`; all eleven files together →
`Test Files 11 passed (11) / Tests 115 passed | 1 skipped (116)`.
`test/unit/killed-run-cleanup.test.ts:173-177` ("sweeps even with no pools to close") asserted the
single pre-close pass and now asserts both passes; it is the one existing assertion M113 changes.

`node node_modules/typescript/bin/tsc --noEmit`: clean.

Corpus, through `C:/Projekte/120fps-fieldtest/scratch/A-M113/dist/cli.js` (built from this worktree
at 416e4f8 plus the uncommitted lane-A changes).

base-ui SIGTERM repro (`EVIDENCE.md:57`), the command verbatim from the Verification section, six
attempts, labels `M113-base-ui-after-1` … `-6`:

Before (`verify/regression-base-ui.md:12`, attempt 2 of 2):
`| base-ui-R1-verify-killwrapper2 | same repro, repeated | 143 | packages/react/.120fps-harness-lagPiI/ (.pid=37396, entry.tsx, index.html) still present 15 s later, ?? packages/react/.120fps-harness-lagPiI/ in git status. Claim failed. |`

After, attempts 1, 2, 4, 5, 6 (`.meta.json` `"exit": 143`, checked 12 s after the kill):

```
=== attempt 6 "exit": 143
ls: cannot access '/e/repositories/base-ui/.120fps-harness-*': No such file or directory
ls: cannot access '/e/repositories/base-ui/packages/react/.120fps-harness-*': No such file or directory
git: []
```

Attempt 3 recorded `"exit": 2` and its log shows the run continuing
(`combo 7: measurement did not complete after 2 retries (target closed); omitted from the report`):
msys `kill -TERM` reached Chromium in the job's process group but not the CLI, so that attempt never
entered the signal path. Its disk was clean all the same (same two `No such file or directory` lines,
empty `git status --porcelain`). Attempt 6 replaces it, so the signal path itself ran five times, exit
143 each time, with no `.120fps-harness-*` left in the repository root or in `packages/react` and an
empty `git status --porcelain` on five of five. Closed: yes.

Run to completion on the same root (`M113-base-ui-after-complete`): `"exit": 0`, `"seconds": 40`,
report reached (`#7 verdict=pass domNodeCount=101 scaleProbe=50 mount=60.5 rerender=24.7`), no
removal line and no leftover — a sweep that removed nothing prints nothing.

A5 on the corpus, the shadcn-admin-F3 pass-gate (`EVIDENCE.md:157`, "leftover .120fps-harness-* dir
after externally interrupted run"): a `.120fps-harness-planted` directory with a dead-pid marker in
`/e/repositories-run5/shadcn-admin`, then the ordinary toolbar run
(`M113-shadcn-admin-sweep-after.log:36`):

```
⚠ Removed a stale harness directory from an earlier run: .120fps-harness-planted (its owner process is gone).
```

`ls -d /e/repositories-run5/shadcn-admin/.120fps-harness-*` → `No such file or directory`. Closed: yes.

Unaffected repo, `EVIDENCE.md:97` (`M113-shadcn-admin-after`): `"exit": 1`, the same code
`logs/shadcn-admin/toolbar-remedy.meta.json` recorded before the change (the run's own page error,
not the sweep); the report is reached
(`W The machine was too busy to measure against. Budget verdicts still print…`, `combos=0`), the log
holds no `stale harness directory`, `Could not remove the harness directory` or `leftover harness`
text, and `ls -d /e/repositories-run5/shadcn-admin/.120fps-harness-*` prints
`No such file or directory`. `src/components/ui/button.tsx --explain-props`
(`M113-shadcn-button-explain-after`) still reaches its explanation: `"exit": 0`,
`Component: Button`.

### End-game fix-up evidence (lane F, 2026-09-03)

The final re-test (`C:/Projekte/120fps-fieldtest/retest/regression-calcom-base-ui.md`, logs
`logs/regression-base-ui/final-base-ui-R1-2.log`, `-3.log`) left base-ui-R1 open: a kill 6 s into the
run exited 143 and left `packages/react/.120fps-harness-8DUjr5/` with no retry and no disclosure
line, and the next run's stale sweep removed it.

Fix, both in lane A's own files:

- `src/harness.ts` — a removal now counts as a removal only when the directory is gone.
  `attemptHarnessDirRemoval` answers the disk (`fs.existsSync`) after the remover returns and reports
  `EBUSY` when the directory is still there, so a Windows `rmSync` that returned on a file another
  process holds open with `FILE_SHARE_DELETE` (unlinked into a pending-delete state) no longer lets a
  caller cross the directory off. `cleanup()` and the bootServer catch forget a directory through
  `forgetHarnessDirIfRemoved` for the same reason.
- `src/harness.ts` — `beginHarnessDirTeardown()` latches the teardown, and `createHarnessDir` removes
  what it creates from that point on, under the A3 budget with the A4 line. A directory created after
  the sweep started is removed by the same handler instead of waiting for the next run.
- `src/cli.ts` — `sweepHarnessDirsAfterClose` latches the teardown before its pass, and `abortRun`'s
  pass after the close runs on both ways out: the deadline exit used to leave through `exit()` alone,
  so a signalled run whose `closeAll` never settled drained its loop with only the pre-close attempt
  spent (A3/A4 never ran). At most one such pass either way.
- `src/harness.ts` — the `process.on("exit")` handler, the last exit any run can take, spends the
  same retry budget and prints the same line (`sweepActiveHarnessDirsOnExit`). The retries are
  synchronous, which is all that event permits, and an empty set costs nothing.

Tests: `node node_modules/vitest/vitest.mjs run
test/unit/signal-teardown-sweeps-before-any-pool-exists.test.ts --maxWorkers=2` →
`Test Files 1 passed (1) / Tests 6 passed (6)`. Against the code before the fix, 3 of the 6 fail; one
failing assertion verbatim:

```
FAIL test/unit/signal-teardown-sweeps-before-any-pool-exists.test.ts > a signal that arrives before any browser pool exists > removes a harness directory created after the sweep started
AssertionError: expected true to be false // Object.is equality
```

The lane's thirteen neighbouring files together (`an-aborted-run-still-prints-its-roots-and-total`,
`exit-watchdog`, `harness-crash-warnings`, `harness-dir-cleanup`,
`harness-dir-removal-retries-and-discloses`, `harness-dir-writability`, `harness-fault`,
`harness-fault-harden`, `harness-sweep`, `killed-run-cleanup`,
`signal-teardown-removes-harness-dirs`, `signal-teardown-sweeps-before-any-pool-exists`,
`stale-sweep-discloses-what-it-removed`) → `Test Files 13 passed (13) / Tests 136 passed | 1 skipped
(137)`. No existing assertion changed.

`node node_modules/typescript/bin/tsc --noEmit`: clean.

Corpus, through `C:/Projekte/120fps-fieldtest/scratch/F-M113/dist/cli.js`, the repro from the
Verification section above, `/e/repositories/base-ui`, labels `fixup-base-ui-1` … `-10`:

| label | kill point | exit | left behind |
|---|---|---|---|
| fixup-base-ui-1, -2, -5, -6 | t+6 s | 143 | nothing; `git status --porcelain` empty |
| fixup-base-ui-3 | first `calibration` line | 143 | nothing |
| fixup-base-ui-4, -7, -8, -9, -10 | first `calibration` line | 143 | one `packages/react/.120fps-harness-*` |

The five leftovers are not the signal path. A scratch dist instrumented with one `process.stderr.write`
at the top of the `SIGTERM` handler, one at the top of `abortRun`, one in the pre-close sweep and one
in the `process.on("exit")` sweep, killed at the same point five times
(`logs/regression-base-ui/fixup-base-ui-dbg*.log`), recorded:

```
=== dbga exit="exit": 143
  (no DBG line at all)
/e/repositories/base-ui/packages/react/.120fps-harness-NYcsNv/
```

— four attempts out of four with exit 143 and not one marker, so the handler never ran, `abortRun`
never ran, and Node's own `exit` event never fired. msys `kill -TERM` on the bash job reaches the CLI
as `TerminateProcess`, and 143 is the exit code that carries, not `terminationExitCode("SIGTERM")`.
The fifth (`fixup-base-ui-dbg`) exited 2 with the run continuing past the kill and
`DBG exit handler size=0` at the end: there the kill reached Chromium only, the run failed on the
closed target and removed its own directory. This is the falsifier `EVIDENCE.md:265` already records
for heroui-R1 ("a wrapper `taskkill /F` delivers no signal, so a hard kill does not exercise this
path"), now measured for msys `kill -TERM` at this kill point: after `TerminateProcess` no in-process
handler exists to sweep anything, and the next run's stale sweep is the whole remedy — which is what
`fixup-base-ui-5` and the completion run recorded, e.g.
`logs/regression-base-ui/fixup-base-ui-complete.log:101`:

```
⚠ Removed a stale harness directory from an earlier run: .120fps-harness-lKU68F (its owner process is gone).
```

Run to completion on the same root (`fixup-base-ui-complete`): `exit=0 killed=false seconds=41`,
`Result: PASS`,
`Total: 39.9s  (preflight 0s, build 1s, calibration 2s, mount 7s, rerender 3s, explore 5s, scale 0s, attribution 0s, analysis 22s)`,
`ls -d /e/repositories/base-ui/.120fps-harness-* /e/repositories/base-ui/packages/react/.120fps-harness-*`
→ `No such file or directory` for both, `git -C /e/repositories/base-ui status --porcelain` empty.

Unaffected repo (`M113-F-shadcn-button-explain-after`,
`/e/repositories-run5/shadcn-admin src/components/ui/button.tsx --explain-props`):
`exit=0 killed=false seconds=2`, `Component: Button`, `Props (32):`,
`ls -d /e/repositories-run5/shadcn-admin/.120fps-harness-*` → `No such file or directory`,
`git status --porcelain` empty. Closed: yes.

Open: the corpus cannot demonstrate the signal path from msys bash on this machine, because
`kill -TERM` terminates the CLI rather than signalling it. A6 and the retry budget on the signal path
are held by the unit tests above; a real SIGINT (console Ctrl-C) or a `process.kill` from a Node
parent would be the corpus-level check, and neither is scriptable from this shell.

## Deferred

- Moving the harness directory outside the project root (a temp dir plus a Vite alias). It would make
  every leftover harmless, and it changes how the project's own aliases and `node_modules` resolve,
  which `src/harness.ts:238-242` records as the reason the directory lives inside the project root.
  Out of scope for a transient-leftover fix.
- A cross-process lock on `.120fps-harness-*` so two concurrent runs never contend for a removal. The
  `.pid` marker plus the heartbeat already answers ownership (`src/harness.ts:3751-3758`), and run 5
  produced no evidence of a concurrent-run collision.
- Making the pre-close sweep unnecessary by closing the pools first. `src/cli.ts:103-108` records why
  directory removal leads: it depends on nothing settling. M113 adds a second pass and never reorders
  the first.
- Forwarding signals from `tools/run120.mjs` to the child. The wrapper installs no handler
  (`verify/regression-base-ui.md:44-47`), which is a property of the field-test harness, not of
  120fps; heroui-R1 is already classified by-design for the same reason.
- Correcting the M101 spec's two falsified claims (`m101:54-57`, `:153-156`: a plain `rmSync`
  succeeds while another live process holds a file inside the directory open). Editing a shipped,
  approved spec is the coordinator's change, not this milestone's.
