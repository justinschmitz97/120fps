---
kind: milestone
status: done
tests:
  - test/unit/m38-server-pool.test.ts
  - test/e2e/m38-sweep-server.test.ts
---

# M38 — cross-component sweep server

## Purpose

Each component of a multi-path run boots its own Vite dev server and pays its
own first navigation (~3–5 s per component post-M34/M35). Harness dirs live
*inside* the project root and the server's `root` is the project root
(`buildAndServe`), so one server can serve every harness dir beneath it — the
server, its transform cache, and its optimized dep bundle are per-project
state, not per-component state. Vite serves files created after boot on
demand, so later components' harness dirs need no watcher and no restart.

## Contract

- `createServerPool()` in `harness.ts`: `acquire(key, boot, include)` boots
  once per key and caches; `closeAll()` closes every pooled server and makes
  further `acquire` throw; `stats().booted` counts real boots. The pool is
  generic over the boot function so it is unit-testable without Vite.
- The pool key is the config tuple that shapes a server:
  `(projectRoot, cssFiles, wrapPath, reactCompiler active, noShims)`.
  A component whose tuple differs boots its own server.
- With a pooled server, `HarnessResult.cleanup()` removes the harness dir and
  MUST NOT close the server; `closeAll()` is the only thing that does.
  Without a pool, behavior is byte-identical to before (own server, cleanup
  closes it).
- `optimizeDeps.include` is frozen at first boot (first component's scan
  unioned with the dep cache — M34's `unionCachedDeps`). On reuse, scanned
  deps missing from the frozen include append `SWEEP_DEP_WARNING` to
  `HarnessResult.warnings` (new, additive); Vite discovers the dep at
  request time and its re-optimize reload is the failure M30's context retry
  survives. `analyze()` forwards `HarnessResult.warnings` into
  `Report.warnings`.
- `AnalyzeOptions.serverPool` passes a pool through to `buildAndServe`
  (including the composition-rollback rebuild). `analyze()` never creates or
  closes a server pool itself — single-component runs gain nothing from one.
- The CLI creates one server pool next to its browser pool for multi-path
  runs and closes it after the last component, crash or not.

## Open questions

- Whether `scanExternalDeps` should pre-scan all sweep components before the
  first boot (kills the mid-sweep re-optimize case at the cost of one
  up-front pass). Deferred until a real sweep shows the warning firing.
