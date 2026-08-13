---
kind: milestone
status: implemented
tests:
  - test/e2e/m47-volatile-dom.test.ts
---

# M47 — volatile DOM normalization

## Purpose

The explorer's state detection hashed component innerHTML (FNV-1a, M4). A
component rendering timestamps, random ids, or animation-churned markup made
every interaction look state-changing: the state graph inflated toward the
200-node cap, adaptive deepening chased phantom states, and exploration budget
burned on noise. The fix is principled rather than heuristic: measure the DOM's
own noise floor before attributing change to interactions.

## Contract

- `probeVolatileRegions(page, gapMs?)` runs once per combo, before discovery and
  before the initial state hash: two content fingerprints `VOLATILITY_PROBE_GAP_MS`
  (250) apart with no input in between. Paths whose content differs are volatile.
- Subsequent state hashes (`computeDomHash`) exclude volatile subtrees' text and
  attribute **values** while keeping their structure — tag names, element
  presence, attribute names. Structural change through a volatile region still
  counts as state change; content churn inside it does not.
- Volatility affects **state attribution only**. Discovery, cost measurement and
  DOM counts are untouched, and interaction targets inside volatile regions stay
  discoverable and exercisable.
- `ExploreResult.volatileRegions` and `StateGraph.volatilePaths` are set when
  anything was found; `analyze` appends `VOLATILE_DOM_NOTICE` naming the combo.
  A component that renders non-deterministically is a finding in itself.
- Determinism holds: identical component behaviour yields an identical graph.
  The probe is part of the deterministic procedure, not a sampling of it.
- A path present in only one of the two probes is a **structural** difference and
  is never marked volatile — that is exactly what state detection must see.

## Design

- Region identity is a structural address (`/TAG[index]` per level from `#root`),
  not object identity, so a remount between samples maps to the same regions.
- The hash became a tree walk rather than a single innerHTML read, which is what
  makes the structure/content split expressible. Cost is bounded by the same
  walk discovery already performs.
- The in-page functions are passed to `page.evaluate` as functions, not source
  strings: Playwright evaluates a string as an expression, so a stringified
  arrow returns the function object rather than calling it.

## Hardening

| # | Hypothesis | Result |
|---|---|---|
| H1 | A ticking clock inflates the state graph | Pass — ≤ 2 nodes for one button |
| H2 | Excluding content hides a real structural change | Pass — the toggle's state is still found |
| H3 | A stable component gets flagged anyway | Pass — no regions, no notice |
| H4 | The probe is non-deterministic | Pass — identical regions across calls |

## Deferred

- Slow-tick volatility: a once-per-second clock beats a 250ms gap. Accepted and
  documented rather than paid for on every combo; re-probing on suspicious
  symmetric flips is the candidate fix if it proves to matter.
- Sharing the probe with M40's `late-mutation` signal. Same underlying
  observation at different times and with different consequences; the
  implementations stay separate until there is a reason to couple them.
- Treating `class`/`style` as content outside volatile regions. Inside a
  volatile region every attribute value already drops out, which covers the
  animation case that motivated the question.
