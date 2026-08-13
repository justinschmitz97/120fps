---
kind: milestone
status: done
tests:
  - test/unit/m34-overhead.test.ts
  - test/unit/m34-dep-cache.test.ts
  - test/e2e/m34-overhead.test.ts
  - test/e2e/m34-harden.test.ts
---

# M34 — profiler overhead reduction

## Purpose

A single-component run against a real Next.js repo (justinschmitz.de, badge.tsx) costs ~5.5 minutes, of which only ~40% is the traced measurement itself. The rest is harness bookkeeping that runs under the 4× CPU throttle and per-sample when per-combo would do. The 44-component budget sweep (`perf-check.mjs`) pays this ~44 times (~3 h). This milestone removes bookkeeping overhead without changing what is measured.

Profile evidence (badge.tsx, matrix path, 329 s total):
- `HeapProfiler.collectGarbage` before every sample: 24–31 ms each under throttle, ~66 s/run.
- `countComponentNodes` + `detectAnimations` on every mount sample, though only the first sample's values are used: ~4 s/run on a tiny component, scales with DOM size.
- Trace start/flush fixed cost: ~11 ms × ~3000 traces ≈ 34 s/run (not addressed here; would change trace handling).

## Contract

- MUST NOT change the content of any traced window: same actions inside `collectTrace`, same trace categories, same double-rAF settle fence.
- MUST keep the 4× CPU throttle engaged during every traced window and during warmup runs (M2: "throttle always on during measurement").
- MAY suspend the CPU throttle for inter-sample bookkeeping that produces no measured value: garbage collection, DOM-info reads, pre-trace unmounts. The throttle MUST be restored before the next `Tracing.start`.
- MUST keep GC before each sample (M6 contract) — only its wall-clock cost may change, not its placement.
- `domNodeCount` and `hasAnimation` MUST be read once per combo (first sample), not on every sample. Reported values are unchanged by construction (only the first sample's values were ever used).
- Reported metrics (mount/unmount/rerender medians, P95, CV, heap deltas, verdicts) MUST agree with pre-M34 runs within run-to-run noise.
- Report JSON schema unchanged.

## Design

- `runMountUnmount` gains a `collectDomInfo` flag: warmup passes and samples s>0 skip `countComponentNodes`/`detectAnimations`.
- New helper `suspendThrottle(cdp, rate, fn)` in `measure.ts`: sets throttling rate 1, runs `fn`, restores `rate` in `finally`. Errors propagate — call sites sit inside `withContextRetry`, whose re-entry re-engages the throttle; nothing may run at an unknown throttle state. Applied to the per-sample GC in `measureMount`, `measureRerender`, and `explore`; the GC moves inside the retry body so a retried sample still GCs first. The react-profiler and isolation loops keep throttled GC (few samples, no retry plumbing).
- `unionCachedDeps(include, metadataJson)` in `harness.ts`: `optimizeDeps.include` is unioned with the `optimized` keys of the project's existing `node_modules/.vite/deps/_metadata.json` and sorted. Any include-list change changes Vite's config hash, which forces a full dependency re-bundle (~10 s) — and the scanned list varies per component, so every component of a sweep paid it. The union converges to a stable superset per project; a new dep re-bundles once and then stays cached. Missing/corrupt metadata degrades to the scanned list.
- The curve check keeps its extracted schemas even when no scaling prop matches, so the matrix check and the standard path stop re-extracting the same file (~1.4 s per repeat on a real Next.js project).
- `server.watch: null` — the harness never edits files mid-run, so file watching is pure cost. Chokidar's initial scan of a real repo (a Next.js `.next/` dir holds thousands of files) saturates the fs threadpool exactly when the first modules load: first navigation measured 11.0 s with the watcher, 1.9 s without. A watcher-triggered reload mid-measurement is also exactly the failure M30's context retry exists to survive.
- `METRICS_REVISION` is 3: removing ~30 ms of throttled idle before each traced window reads mount/unmount medians up to ~6 % higher than revision 2 (interleaved A/B on badge.tsx: mount ×1.058, rerender ×0.982, unmount ×1.074, CVs unchanged). Pre-M34 baselines classify `incompatible` instead of silently comparing.

## Open questions

- Whether suspending throttle for the untraced setup mounts in `measureRerender` shifts phase alignment for entrance-animated components (rerender fires earlier in the component's animation timeline). Deferred: setup mounts stay throttled until measured evidence says otherwise.
