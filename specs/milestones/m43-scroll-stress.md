---
kind: milestone
status: implemented
tests:
  - test/unit/m43-scroll-stress.test.ts
  - test/e2e/m43-scroll-stress.test.ts
---

# M43 — scroll & wheel stress pattern

## Purpose

Scroll jank is the most common real-world interaction complaint for lists,
tables, and virtualized components, and it was the one interaction class the
tool did not exercise (M15 excluded wheel/scroll). A virtualized list's entire
cost model lives in its scroll handler; without this the tool reports it as a
cheap mount with few interactions.

## Contract

- Discovery finds scroll containers: computed `overflow-y`/`overflow-x` of
  `auto`, `scroll` or `overlay` **and** content actually exceeding the box
  (`scrollHeight > clientHeight + 1`, or the horizontal pair). Style alone is
  not enough — every `overflow: auto` wrapper in a tree would otherwise claim a
  sweep it cannot answer.
- `InteractionType` gains `"scroll"`; `InteractionDescriptor` gains
  `scrollAxis: "vertical" | "horizontal"`. Vertical wins when both axes
  scroll: that is the axis a wheel drives.
- `scrollAxis` is recorded on **every** overflowing container. The `"scroll"`
  *type* is claimed only when nothing else does — not for
  `BUTTON/A/INPUT/TEXTAREA/SELECT/SUMMARY`, not for an element with an ARIA
  role, not for contenteditable. A scrollable listbox keeps its keyboard sweep,
  which measures more than a wheel would.
- The document scrollport becomes a descriptor with selector `:root` when
  harness content overflows the viewport — a plain list long enough to overflow
  scrolls the document, not a container.
- Existing descriptor invariants hold: determinism, dedupe, document order,
  shadow-DOM traversal.
- `scroll-sweep` in `stress-patterns.ts` is the highest-priority dispatch for
  `"scroll"` descriptors: `SCROLL_SWEEP_STEPS` (10) wheel ticks out and 10
  back via `page.mouse.wheel`, ending at the initial offset so the state graph
  sees a round trip (rapid-toggle-11's end-state discipline).
- One step carrying `moveCount: 20`, so `countPatternEvents` bills each wheel
  tick as one event and the M33 per-event frame budget applies unchanged. The
  count is fixed because budgets must be known before the sweep runs; the
  distance per tick is what adapts.
- Scroll position is not application state: `StressPattern.stateInvariant`
  makes the explorer treat the edge as a self-loop, recording cost and metrics
  without consulting the DOM hash. Otherwise virtualized windowing mints one
  node per scroll offset.
- Scroll measurement runs under the explorer's existing vsync pacing.
- MUST NOT: touch/momentum emulation, scrollbar dragging, scroll-linked
  animation timelines, waiting out `scroll-behavior: smooth`.

## Design

- Tick distance is `min(clientHeight * 0.8, range / 10)`, computed in the page
  at execution time. A 10-row list traverses exactly its range; a virtualized
  list reporting a 400,000px `scrollHeight` stops after eight viewports.
  Representative either way, bounded always.
- The pointer is moved over the container before the first tick — a wheel event
  goes wherever the pointer is. Centres are clamped into the viewport, since a
  wheel at negative coordinates lands on nothing. `:root` uses viewport centre.
- `scroll-behavior` is forced to `auto` on the container as part of reading its
  box: measuring easing duration is not measuring handler cost. The override is
  idempotent, so repeated sweeps see one state; it is not restored.

## Hardening

| # | Hypothesis | Result |
|---|---|---|
| H1 | A selector matching nothing throws | Pass — no-op |
| H2 | A container with no scroll range throws | Pass — no-op |
| H3 | A 20,000-row list sweeps unbounded | Pass — capped at 8 viewports, returns to 0 |
| H4 | Smooth scrolling measures easing instead of handler cost | Pass — forced to `auto` |
| H5 | Scroll discovery breaks determinism | Pass — identical across calls |

Regression: the existing discovery, discovery-harden and portal suites (36
tests) pass unchanged — no fixture gained a spurious scroll descriptor.

## Deferred

- Nested scroll containers each get a sweep today (a scrollable table inside a
  scrollable panel yields two descriptors). An innermost-only dedupe rule is
  plausible but unmeasured.
- A dedicated scroll metric (dropped frames during the sweep) as its own report
  column rather than folding into the per-event budget. The frame data is
  already in the trace; this is a reporting decision that belongs with M51.
