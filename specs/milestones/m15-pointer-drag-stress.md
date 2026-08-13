---
kind: milestone
status: done
tests: [pointer-drag.test.ts, pointer-drag-harden.test.ts]
---

# M15 — pointer-drag stress

pointerdown → 60 linear pointermoves across bounding box → pointerup (~1s drag @60fps). Vertical axis via aria-orientation, else horizontal. Playwright page.mouse (real coordinates from rect; element missing → step skipped).

Non-obvious:
- Targets, checked in order: role slider, input[type=range], aria-valuenow present, computed cursor in {grab, col-resize, row-resize}. Highest priority in dispatch — before keyboard-sweep etc.
- Rejected: HTML5 draggable (uses dragstart/dragover/drop, not pointermove); cursor "grabbing" (active drag state, not idle affordance); configurable move count; touch simulation (pointer events cover it); scroll/wheel (separate concern).
- Descriptor fields added: ariaValueNow, ariaOrientation, cursor — populated in all three walkers (raw, shadow, portal).
