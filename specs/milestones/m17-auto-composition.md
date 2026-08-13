---
kind: milestone
status: done
tests:
  - test/unit/composition.test.ts
  - test/unit/composition-cli.test.ts
  - test/unit/composition-report.test.ts
  - test/unit/composition-harden.test.ts
  - test/unit/extract-exports.test.ts
---

# M17 — auto-composition

Multi-export file, no fixture → infer scene from names alone (never library-specific, never imports the library at build time).

Phase 1: root = shortest export whose name prefixes all others (case-insensitive, must be an exact export). No shared prefix among ≥2 exports → null. Single export skips.

Phase 2 suffix taxonomy (surveyed Radix/shadcn/HeadlessUI/ArkUI/Mantine/Chakra/ReactAria): Item=repeatable child (repeatNode ×3), Trigger/Header/Title/Label=first in container, Content/Body/Panel/Description=after trigger, List/Group=trigger container with content OUTSIDE (tabs shape), Overlay/Backdrop/Portal=root child before content, Close/Footer inside Content, unknown suffix=root child. `children` in schema ⇒ can wrap; without ⇒ always leaf.

Template pick: List/Group→list-based; Item w/o List→item-based; Portal/Overlay→portal-based (root gets open={true}); else flat. Empty-DOM retry props: defaultValue/defaultOpen/open/value="0" (Radix conventions).

Non-obvious:
- repeatNode feeds M8 scaling ([1,5,20,50]) without a scale() export.
- Fixture always beats composition; sub-component prop combos not generated (root combos only).
- Phase 3 (trial mount + context-error retry) was deferred here; M30 F3 landed trial mount as rollback-to-uncomposed, not retry.

Deferred: cross-file inference; re-export chains untested.
