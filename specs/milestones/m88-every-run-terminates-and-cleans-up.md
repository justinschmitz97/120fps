---
kind: milestone
status: draft
tests:
  - test/unit/exit-watchdog.test.ts
  - test/unit/harness-dir-cleanup.test.ts
---

# M88: every run terminates and cleans up

## Purpose

taxonomy printed a complete, well-written fatal error and the process was still alive roughly twenty
minutes later, until an external timeout killed it. A user sees a correct error and a terminal that
never returns. Separately, excalidraw leaked a harness directory on a `PASS` run (inverting the
previous crash-gated cleanup assumption), and heroui's leaked directory lived at
`packages/react/.120fps-harness-*`, nested under the workspace member the harness actually builds in.

## Contract

### MUST

- After a fatal error is printed, the process exits with its documented code within 10 seconds.
- The documented exit-code table holds: `0` pass, `1` verdict failure, `2` setup error. A
  setup-shaped failure never exits `124` and never hangs.
- Harness directories are removed on every exit path, including `PASS` / exit 0.
- Cleanup finds harness directories at the workspace member root, not only the repository root.

### MUST NOT

- Depend on a later, unrelated invocation to sweep a directory the current run created.

### Invariants

- A run that completes cleanly (no error, no timeout) exits exactly the same way it did before this
  milestone: the watchdog is armed only around teardown following a fatal error or the end-of-run
  pool teardown, and is always cancelled once that teardown finishes on time.
- `activeHarnessDirs` (`src/harness.ts`) still names every harness directory from the moment
  `createHarnessDir` returns it until it is removed, independent of this milestone's changes.

## Design

Two independent guarantees, both entirely inside `src/cli.ts` and `src/harness.ts`.

**Bounded exit.** `main()`'s single-component crash path (`cli.ts`, the `!multi` branch of the
per-component catch) previously called `process.exit(2)` synchronously, immediately after printing
the error — bypassing the browser-pool and server-pool teardown that lives in the loop's `finally`
block entirely, since `process.exit()` does not run pending `finally` blocks. The multi-component
tail (after the loop) awaited that same teardown unconditionally before its own `process.exit`. A
teardown step that never settles — closing a Vite dev server whose `transformRequest()` is mid-flight
is the shape previously known only from vitest's own dev-server teardown — leaves that `await` pending
forever, and the process that already printed its fatal error is never told to exit.

Two layered primitives in `src/cli.ts`. `armExitWatchdog(exitCode, timeoutMs = 8000)` arms an unref'd
`setTimeout` that calls `process.exit(exitCode)` directly — unref'd so it never *by itself* keeps an
otherwise-idle process alive, but a hung teardown keeps other handles open regardless, so the timer
still fires on schedule. `closePoolsBounded(pool, serverPool, timeoutMs = 8000)` best-effort-awaits
both `closeAll()` calls via `Promise.allSettled` (one hanging or throwing never blocks the other),
raced against its own internal timer, so its own returned promise always settles within the bound —
it never calls `process.exit` itself. Every exit site now arms the watchdog, awaits
`closePoolsBounded`, clears the watchdog, then calls `process.exit(code)` explicitly and
synchronously (which cannot itself hang): the watchdog is the outer, harder guarantee: if anything
else after `closePoolsBounded` returns somehow still hung, it fires anyway. Both the single-component
crash path (previously bypassed pool teardown entirely via a bare synchronous `process.exit(2)`) and
the end-of-run tail (previously awaited teardown unconditionally with no bound) now route through
this pair, with 8 seconds of margin inside the 10-second contract for the message print and the final
`process.exit` call.

`src/harness.ts`'s own dev-server teardown gets the same bound at its source: `cleanup()`
(`buildAndServe`'s returned closure) and `createServerPool().closeAll()` both call `server.close()`
directly; both now race it against a 5-second unref'd timer via `closeServerBounded`, so a single
hung server can never block either the per-component `cleanup()` a caller awaits or the pool's own
`closeAll()` — the same primitive answers both call sites.

**Cleanup at the workspace member root.** `sweepStaleHarnessDirs` and `createHarnessDir` are already
called with `projectRoot` — the component's own package directory — not the repository or workspace
root (`buildAndServe`, `src/harness.ts`). For a pnpm/npm/yarn workspace member (heroui's
`packages/react`), `projectRoot` already *is* that member directory, so harness directories are
already created and swept there, not only at a higher repo root. This milestone adds a regression
test pinning that behavior against a nested workspace-member fixture, since the map's evidence was
gathered by an external check that looked only at the git repository root and could not see this.

## Open questions

None.

## Verification

- A fixture teardown (`pool`/`serverPool` stand-ins) whose `closeAll()` never resolves: assert
  `closePoolsBounded` still settles, and calls `process.exit` with the intended code, within the
  configured bound (using an injectable short timeout for the test, not the real 8s default).
- A fixture teardown whose `closeAll()` resolves quickly: assert the watchdog is cancelled and
  `process.exit` is not double-invoked by the timer.
- `closeServerBounded` against a `server.close()` stub that never resolves: assert it settles within
  its bound.
- `sweepStaleHarnessDirs`/`createHarnessDir` invoked with a nested workspace-member directory as
  `projectRoot`: harness directories are created and swept there, independent of any repository-root
  directory.
