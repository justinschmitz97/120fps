---
kind: milestone
status: approved
tests:
  - test/unit/killed-run-cleanup.test.ts
  - test/unit/harness-sweep.test.ts
  - test/unit/harness-dir-cleanup.test.ts
---

# M101: a killed run leaves nothing behind

Lane A. Closes base-ui-F2, heroui-F4, excalidraw-F3, the shadcn-ui leftover and dub-F4.
Root cause: `C:\Projekte\120fps-fieldtest\verify\V2-harness-leftovers.md`.

## Purpose

Every removal site for a `.120fps-harness-*` directory runs inside the process that created it
(`cleanup()`, the boot catch, and the `process.on("exit")` sweep at `src/harness.ts:281`), and Node
does not emit `"exit"` for a process terminated by a signal or by `TerminateProcess`. An externally
killed run therefore bypasses the only last-resort site, and nothing else removes the directory for
at least an hour — and only then if a later run measures a component under the same project root
(`sweepStaleHarnessDirs`, age-gated at `STALE_HARNESS_MAX_AGE_MS`, called from `buildAndServe`).

V2 reproduced this directly (repro 5): a run left alive as an orphan (PID 70660) still held
`.120fps-harness-q5eb1N`; `Stop-Process -Force` left the directory behind after the process was gone.
It also refuted the two findings that blamed a *completed* run — a run that prints a report removes
its own directory (repros 2, 3, 4), so the leak is the killed run, not the failed one.

Second gap V2 names: the M88 watchdog is armed only after `runOne` returns (`src/cli.ts:1234`,
`:1247`). Nothing bounds a hang *inside* `analyze()`, so an interrupted run can stay alive and idle
indefinitely (observed: 11+ min, 20 s CPU, children alive) holding its directory and its Chromium.

## Contract

- inputs: a signal (`SIGINT`, `SIGTERM`, `SIGHUP`) or a phase that stops making progress; a project
  root that may hold harness directories from this and other processes.
- outputs: no `.120fps-harness-*` directory belonging to this run; no orphaned Chromium or esbuild
  child; the documented exit code (`128 + signo` for a signal, `2` for a watchdog abort).
- constraints: an "exit"-time sweep may only do synchronous work; a directory belonging to another,
  live run is not this run's to delete; nothing outside `.120fps-harness-*` is ever touched.
- non-goals: cleaning up leftovers in a project 120fps is not currently pointed at; killing a
  Chromium process Playwright's public API does not expose (M92's documented limitation, unchanged).

## MUST (from `specs/milestones/M97-M106-MAP.md`)

- `SIGINT`, `SIGTERM` and `SIGHUP` run `sweepActiveHarnessDirs()`, close the browser pool, and
  re-exit with `128 + signo` (`cli.ts:1541` area).
- Every harness dir carries a `.pid` marker; `sweepStaleHarnessDirs` removes dirs whose pid is dead
  regardless of age, and the age gate for live-pid dirs drops from 1 h to 10 min.
- The fatal-exit watchdog bounds the whole run: armed before `runOne`, re-armed per phase heartbeat,
  so a hang inside `analyze()` cannot hold the dir and child processes indefinitely (budget: the
  larger of `--explore-budget` + 10 min or 20 min; documented below).
- Child processes are closed on every exit path above, through the browser pool and the dev-server
  pool. Restated after review: `closePoolsBounded` *asks* Playwright and Vite to close and is
  bounded — a `closeAll()` that never settles is abandoned, not force-killed, because Playwright's
  public API exposes no process handle for a `chromium.launch()` browser (M92 1.5b, unchanged). The
  harness directory removal that precedes it is synchronous and unconditional, so the MUST that
  matters ("leaves nothing behind" on disk) holds even when a browser process outlives the run.

## MUST NOT

- Sweep a dir whose pid is alive and younger than the gate.
- Touch anything outside `.120fps-harness-*`.

## Design

**Signal handlers (`src/cli.ts`).** `abortRun(exitCode, pools, hooks)` is the one teardown both new
exit paths share: it sweeps the active harness dirs first (synchronous `rmSync`, the only step that
must not depend on anything settling), then arms the existing `armExitWatchdog` and awaits
`closePoolsBounded`, then exits. Registered for all three signals in the direct-run block only —
never when `cli.ts` is imported by a test — matching the existing `unhandledRejection` /
`uncaughtException` registration's own reasoning. `terminationExitCode(signal)` is
`128 + os.constants.signals[signal]`, so `SIGINT` exits 130, `SIGHUP` 129 and `SIGTERM` 143, the
shell's own convention for a signalled process.

Closing the browser pool is what kills Chromium: Playwright's `browser.close()` ends the browser
process, and its dev-server siblings (esbuild workers) die with the Vite server that owns them
(`serverPool.closeAll()`). When either hangs, `armExitWatchdog` still delivers the exit code, and
the harness directories are already gone by then because the sweep ran first.

**Pid marker (`src/harness.ts`).** `createHarnessDir` writes `.pid` containing the creating
process's pid, immediately after `mkdtempSync`, best-effort: a marker that cannot be written must
not fail the run, and its absence only costs the dir the older, more conservative gate.
`sweepStaleHarnessDirs` reads it and decides per directory:

| marker | process | removed |
|---|---|---|
| absent (pre-M101 dir, or unwritable) | unknown | age > 1 h (`STALE_HARNESS_MAX_AGE_MS`, unchanged) |
| present | dead (`process.kill(pid, 0)` throws `ESRCH`) | always |
| present | alive (`EPERM` counts as alive: a foreign owner) | age > 10 min (`LIVE_PID_HARNESS_MAX_AGE_MS`) |

`process.kill(pid, 0)` sends no signal; it only asks the OS whether the pid can be signalled.
`EPERM` means the pid exists and belongs to another user, so it counts as alive — treating it as
dead would delete a directory a live process is still writing.

**Run watchdog (`src/cli.ts`).** `runWatchdogBudgetMs(exploreBudgetSeconds)` is
`max(exploreBudget + 10 min, 20 min)`, with the CLI's own default explore budget (300 s) when the
flag is absent, so the floor for a default run is 20 minutes and an explicitly long exploration
still gets its budget plus the fixed 10-minute margin for everything around it. `createRunWatchdog`
arms a timer before `runOne` and `heartbeat()` re-arms it; `runOne` passes `onProgress` so every
phase line (`preflight: walking the import graph`, `harness: building`, `calibration`, `mount: …`)
is a heartbeat. Under `--ci` the progress reporter is a no-op by design
(`resolveProgressReporter`, `analyze.ts:386`), so there the budget bounds the whole run instead of
each phase — the weaker of the two guarantees, and still a bound.

On expiry the watchdog prints what it bounded and takes the same `abortRun` path with exit code 2.
The timer is `unref()`d, so it never keeps an otherwise-finished process alive, and it is cleared in
`finally` around each component of a sweep.

## Review fixes (2026-08-21)

- **A6** — the live-pid gate read the *directory's* mtime, which stops advancing once the build has
  written `entry.tsx`, so any run longer than the gate looked abandoned while it was measuring.
  Liveness is now the `.pid` marker's own mtime, refreshed by `refreshHarnessDirMarkers()` at every
  phase heartbeat, and a directory whose marker names **this** process is never swept at any age.
- **A2** — under `--ci` the progress reporter is a no-op, so no phase line can re-arm the watchdog
  and the budget bounds the whole run. `RUN_WATCHDOG_ABORT_ERROR` now takes that mode and says
  "exceeded its total budget of N minutes" instead of "made no progress", which was false of a
  healthy CI run. Per-phase bounding under `--ci` needs an `onHeartbeat` sink read before
  `resolveProgressReporter`'s `options.ci` short-circuit (Lane C).
- **A8** — `abortRun` sets `process.exitCode` before awaiting the pools, so a loop that drains while
  a close is still pending exits with `128 + signo` rather than 0.
- **A13** — the `activeHarnessDirs` comment no longer claims a one-hour age gate.
- **calcom-R1 (orphan node process holding a harness dir)** — 120fps starts no node child of its
  own: `child_process` appears once in `src/` (`compare.ts`'s `execFileSync` for git), and there is
  no `fork`, `spawn`, `process.execPath` re-exec or `Worker` anywhere (pinned by
  `test/unit/killed-run-cleanup.test.ts`, "processes a run is responsible for"). A surviving process
  with the run's argv is therefore that run's own process, from an *earlier*, killed attempt of the
  same command — the confound V2 already documented ("the directory mtime records *a* run's start,
  not necessarily the logged one"). Measured directly while three lanes were running here: a WMI
  match on `*cli.js*Badge.tsx*` returned two processes, one of them another lane's live
  `dub badge.tsx --matrix` run, matched only because the filter is case-insensitive and argv-shaped.
  What A6 changes for a real orphan: an idle process stops refreshing its `.pid` marker, so its
  directory becomes sweepable ten minutes after its last phase instead of being held for as long as
  the process lives. Live check, the finding's own command against a scratch build
  (`logs/fix-a-review-calcom2.log`): `Result: PASS`, `Total: 8m 31s`, `EXIT=0`; five seconds later a
  WMI query for `node.exe` whose CommandLine matches this run returns nothing, `packages/ui` holds no
  `.120fps-harness-*`, and `git status --porcelain` is empty.

## Windows: shell timeouts and the dub leftover (investigated 2026-08-21)

**A shell `timeout` does terminate the run.** Measured from Git Bash against the shipped dist:
`timeout 5 node dist/cli.js packages/react/separator/src/separator.tsx --samples 3 --max-combos 1`
in `/e/repositories/radix-primitives` returned `TIMEOUT_EXIT=124`, and a per-3-second WMI poll for
`node.exe` with that command line showed it present at t=3 s and t=6 s and **absent from t=9 s
through t=60 s**. The run's own log records what it saw on the way out
(`combo 4: measurement did not complete after 2 retries (target closed)`). So msys `timeout` is not
an orphan source here. What does produce one is a parent-shell kill that never signals the native
child — a tool-call timeout, a closed terminal, `Stop-Process` on the shell — which is V2 repro 5's
shape, and is why the pid marker and the per-phase watchdog both exist.

**The dub leftover (`packages/ui/.120fps-harness-sLy6s8`, marker 63632 written 20:03:49, three full
runs on that root at ~22:20 did not sweep it) is not reproducible from the code as shipped.** At
fixture level, against the same dist: a directory whose marker names a live foreign pid and whose
marker *and* directory mtimes are two hours old is swept on the next call, and a plain `rmSync`
succeeds even while another live process holds a file inside it open for reading (Windows shares
read handles). The predicate does not short-circuit on liveness (`!isProcessAlive(owner) || marker
older than the gate`), `findProjectRoot` for `packages/ui/src/badge.tsx` is `packages/ui` — the
directory that held it — and the sweep runs inside `buildAndServe` before `createHarnessDir`, on
every run. The two explanations left are outside what is still observable (the directory was removed
at 22:45): those runs used a lane scratch build predating the A6 marker-heartbeat fix, or they never
reached `buildAndServe`.

What changed as a result: a removal that *fails* is no longer swallowed by the same `catch` that
covers "already gone". `sweepStaleHarnessDirs(projectRoot, warningsOut?, remove?)` reports
`HARNESS_DIR_UNREMOVABLE_WARNING(dir, reason)` into the run's warnings, so the next occurrence names
itself and its errno instead of looking like a directory nothing was wrong with.

## Open questions

- The 10-minute gate for a *live foreign* pid now measures marker staleness, not directory age, so a
  run that is still working refreshes itself out of reach of another process's sweep. What remains
  is a run whose phases are more than ten minutes apart (a single very long explore with no phase
  line in between): its marker goes stale while it is alive. Raising the gate, or refreshing the
  marker from a timer rather than from phase lines, is the next lever if the corpus ever shows one.

## Verification

### Unit

`test/unit/killed-run-cleanup.test.ts`:

- `terminationExitCode` returns 130 / 143 / 129 for SIGINT / SIGTERM / SIGHUP (`128 + signo`).
- `abortRun` removes the tracked harness directories before it closes the pools, closes both pools,
  and exits with the code it was given — asserted through injected `sweep`/`exit` hooks and a real
  temporary directory, with a hostile pool whose `closeAll()` never settles still reaching the exit.
- `runWatchdogBudgetMs` floors at 20 min, adds 10 min to an explicit explore budget, and uses the
  CLI's own 300 s default when the flag is absent.
- `createRunWatchdog` fires after its budget, does not fire when `heartbeat()` keeps arriving, and
  stops firing once cleared.
- A harness directory created by `createHarnessDir` carries a `.pid` marker naming the creating
  process.
- `sweepStaleHarnessDirs` removes a fresh directory whose marker names a dead pid, keeps a fresh
  directory whose marker names this live process, removes a live-pid directory older than 10
  minutes, and still applies the one-hour gate to an unmarked directory.

`pnpm vitest run test/unit/killed-run-cleanup.test.ts test/unit/harness-sweep.test.ts
test/unit/harness-dir-cleanup.test.ts test/unit/exit-watchdog.test.ts test/unit/cli.test.ts`:

```
 Test Files  5 passed (5)
      Tests  56 passed (56)
```

Lane-wide `pnpm vitest run test/unit/ --maxWorkers=4 --reporter=dot` (all three lanes' files):

```
 Test Files  245 passed (245)
      Tests  3933 passed | 1 skipped (3934)
```

`pnpm lint` (`tsc --noEmit`): clean.

### Real repository

`E:/repositories/base-ui`, full log in
`C:\Projekte\120fps-fieldtest\logs\fix-a-m101.log`. A run is started, hard-killed with
`taskkill /F` (TerminateProcess: no signal, no `"exit"` event — the V2 repro-5 shape), and the
leftover it leaves is swept by the next run at 1.5 minutes old, far inside both age gates:

```
$ sleep 12; find packages/react -maxdepth 1 -name ".120fps-harness-*"
packages/react/.120fps-harness-VZsc3i
$ cat packages/react/.120fps-harness-VZsc3i/.pid
9100
$ taskkill /F /PID 9100
ERFOLGREICH: Der Prozess mit PID 9100 wurde beendet.
$ find packages/react -maxdepth 1 -name ".120fps-harness-*"
packages/react/.120fps-harness-VZsc3i           # the leak, still there
$ tasklist /FI "IMAGENAME eq chrome.exe" /FO CSV | wc -l
1                                                # header only: no orphaned browser
$ node .../cli.js packages/react/src/button/Button.tsx --samples 3 --max-combos 2 \
    --explore-budget 20 &                        # any later full run
$ sleep 14; test -d packages/react/.120fps-harness-VZsc3i && echo YES || echo "NO (swept)"
NO (swept)
$ # that run then finishes and removes its own:
Total: 2m 0s
$ find packages/react -maxdepth 1 -name ".120fps-harness-*"
(no output)
$ git status --porcelain
(empty)
```

Signal delivery itself could not be exercised on this host, and the limitation is the host's, not
the fix's: Git Bash's `kill -INT` does not reach a native Node process (verified against a
SIGINT-handler probe — no handler ran, the process survived), and `taskkill` without `/F` refuses a
console process with no window ("Die Beendigung dieses Prozesses muss erzwungen werden"). Handler
registration, the `128 + signo` exit code and the teardown order are covered by
`test/unit/killed-run-cleanup.test.ts`; the hard-kill path, which is what Windows can deliver, is
covered by the repro above end to end.
