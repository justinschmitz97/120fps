---
kind: decision
status: approved
---

## Context
Given a rendered component, how to discover what to benchmark?

## Decision
Adaptive exploration loop: discover interactions at runtime, deepen into expensive paths.

## Why
- Fixed templates miss component-specific behavior (accordion, select, tabs).
- Manual play functions = per-component effort = the problem we're solving.
- DOM walking discovers actual interactables without prior knowledge.

## Algorithm
1. Mount with prop combo, discover interactables via DOM walk.
2. Exercise each N=10, measure via CDP trace.
3. P95 > 1.5× median → add follow-up interactions to priority queue.
4. Dedup states via DOM structural hash.
5. Terminate: convergence (<5% info gain last 10) / 200 nodes / 60s / depth 4.

## Consequences
- Non-deterministic exploration order. Mitigated: seeded RNG, deterministic DOM hashing.
- ~10-20s exploration overhead. Acceptable for coverage depth.
- Cannot discover interactions requiring specific prop combos to reveal. Mitigated: prop matrix covers boolean/union variants.
