---
kind: milestone
status: done
tests:
  - test/unit/explorer.test.ts
  - test/e2e/explorer.test.ts
  - test/e2e/explorer-harden.test.ts
---

# M4 — exploration loop

BFS state graph. State id = FNV-1a hash of #root innerHTML. Each edge N samples; each sample = remount + replay pathFromRoot + traced exercise.

Non-obvious:
- Adaptive deepening: edge P95 > 1.5× global median edge cost → follow-ups jump to queue front.
- Convergence: stop after 10 consecutive zero-gain explorations (gain binary: new node/edge). Hard limits: 200 nodes, 60s wall clock, depth 4.
- Seeded LCG PRNG (default 42) shuffles interactions → determinism.
- TRAP: `comboIndex` is the position in the combos array RECEIVED. Subset callers (matrix hot cells) MUST `restoreComboIndices(results, sourceIndices)` — skipping silently attaches interactions to wrong combos; downstream joins on comboIndex cannot detect it.
- Shadow selectors (`>>>`) exercised via evaluate fallback; double-rAF after each exercise.

Open: nondeterministic components spawn spurious states (200-node cap holds); link clicks that navigate break exploration.
