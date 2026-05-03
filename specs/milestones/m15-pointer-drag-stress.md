---
kind: milestone
status: done
tests: [pointer-drag.test.ts, pointer-drag-harden.test.ts]
---

## Purpose

120fps has six stress patterns (rapid-toggle, keyboard-sweep, hover-sweep, open-close-10, multi-keystroke, single-shot) but none exercise continuous pointer interactions. Sliders, color pickers, comparison sliders, and carousels rely on high-frequency pointermove/drag handlers that must sustain 60fps. This is the only genuine performance gap between 120fps and hand-written bench suites.

## Builds on

M10 (stress pattern dispatch + execution). M3 (interaction discovery with type/role annotation).

## Contract

### MUST

- Add `pointer-drag` stress pattern to `src/stress-patterns.ts`.
- Pattern: pointerdown → N pointermove events across element bounding box → pointerup. Default N=60 (simulates ~1s drag at 60fps).
- Move events distributed linearly across the element's width (horizontal) or height (vertical, detected from `aria-orientation`).
- `resolveStressPattern` dispatches `pointer-drag` for: `role="slider"`, `input[type=range]`, elements with `aria-valuenow`, and elements matching cursor heuristic (grab/col-resize/row-resize via getComputedStyle).
- Pointer-drag dispatched via Playwright `page.mouse` API (move/down/up) with correct clientX/clientY coordinates derived from element bounding rect.
- Double-rAF settle after pointerup (consistent with existing patterns).
- `StateEdge.stressPattern` records `"pointer-drag"` for affected interactions.
- Terminal table shows `(pointer-drag)` suffix like other non-single-shot patterns.
- Backward-compatible: components without drag-eligible elements behave identically to M14.

### MUST NOT

- Add touch event simulation (pointer events cover touch via pointerType).
- Simulate scroll/wheel events (separate concern).
- Change existing stress pattern dispatch for non-drag interactions.
- Require user annotation to identify drag targets.

### Invariants

- All existing tests pass unchanged.
- pointer-drag pattern produces valid CDP traces with frame timing data.
- Elements that don't match drag heuristics still get their current stress pattern.

## Design

### Detection heuristic (in resolveStressPattern)

`isDragTarget(descriptor)` checks in order:
1. `descriptor.role === "slider"` → true
2. `descriptor.inputType === "range"` → true
3. `descriptor.ariaValueNow === true` → true
4. `descriptor.cursor` in `DRAG_CURSORS` (grab, col-resize, row-resize) → true
5. false → fall through to existing dispatch

Drag detection has highest priority in `resolveStressPattern` — runs before keyboard-sweep, hover-sweep, and all other patterns.

### InteractionDescriptor extensions

Three new optional fields added to `InteractionDescriptor`:
- `ariaValueNow?: boolean` — true when `aria-valuenow` attribute is present
- `ariaOrientation?: string` — value of `aria-orientation` attribute
- `cursor?: string` — computed CSS cursor value

Populated in `extractRaw`, `extractRawShadow`, and portal walker. `inferAriaRole` maps `role="slider"` → `"slider"`.

### StressStep extensions

- `action` union includes `"pointer-drag"`
- `moveCount?: number` — number of pointermove events (default 60)
- `direction?: "horizontal" | "vertical"` — sweep axis

### Pointer event sequence

```
page.mouse.move(startX, startY)
page.mouse.down()
for i in 0..moveCount:
  t = i / moveCount
  page.mouse.move(lerp(startX, endX, t), lerp(startY, endY, t))
page.mouse.up()
// 2× rAF settle (handled by executeStressPattern loop)
```

Horizontal: sweep x across element width, y at vertical center.
Vertical: sweep y across element height, x at horizontal center.

### Bounding rect

Obtained via `element.getBoundingClientRect()` inside `page.evaluate` before the sequence starts. If element not found, step is skipped.

## Resolved questions

- `draggable="true"` HTML5 drag targets: No — HTML5 drag uses dragstart/dragover/drop, not pointermove.
- Move count configurable: No — 60 is a reasonable default matching 1s at 60fps.
- `cursor: "grabbing"`: Not in DRAG_CURSORS — it's the active drag state, not the idle affordance.
