---
kind: milestone
status: done
tests:
  - test/unit/portal.test.ts
  - test/unit/portal-harden.test.ts
  - test/e2e/portal.test.ts
  - test/e2e/portal-harden.test.ts
---

## Purpose

Portal-based components (Modal, Popover, Select dropdown, Sheet) render interactive content into `document.body` outside `#root`. The DOM walk is extended to cover portal content, enabling measurement of the most complex UI components.

## Builds on

M8 (rerender + scaling). The full measurement pipeline is in place. M9 widens discovery scope without changing measurement infrastructure.

## Contract

### MUST

- `discoverInteractions(page, options?)` walks `document.body` children in addition to `#root`.
- Framework internals filtered: `SCRIPT`, `STYLE`, `LINK`, `NOSCRIPT` tags and Vite overlay elements skipped.
- Deduplicate: elements inside `#root` are not double-counted when walking body.
- Trigger-first discovery: when `probePortals: true`, exercise each trigger with `aria-haspopup` attribute. After each trigger, re-walk `document.body` to find newly appeared portal content.
- Portal interactions linked to the trigger that revealed them. `InteractionDescriptor` extended with `portal?: boolean` and `triggeredBy?: string`.
- Portal interactions appear in `ComboReport.interactions` with `portal: true` flag.
- Two-phase wait: 2 rAFs for synchronous portals, then MutationObserver up to 2s for async portals (only for triggers with `aria-haspopup`).
- Handle multiple portals per component (e.g., nested popover inside modal).

### MUST NOT

- Walk shadow DOM host elements outside the component's own shadow roots.
- Interact with elements from other components sharing the page.
- Break the existing `#root`-only discovery path. Components without portals produce identical results.
- Modify the harness entry or Control API.

### Invariants

- Portal discovery uses the same `TreeWalker` + visibility filtering as `#root` discovery.
- Portal interactions are measured with the same CDP tracing as `#root` interactions.
- Deterministic: same component + same props → same portal interactions discovered.
- All existing tests pass unchanged.

## Design

### Discovery flow

```
1. Mount component via Control API (caller responsibility).
2. Phase 1: walk #root → InteractionDescriptor[] (existing behavior).
   Also walk body children outside #root → append with portal=true (always-open portals).
3. Phase 2 (portal probe, when probePortals=true):
   a. Batch-check all click/focus triggers for aria-haspopup attribute.
   b. For each trigger WITH aria-haspopup:
      i.   Remount component (via remount callback).
      ii.  Snapshot document.body child count.
      iii. Exercise the interaction (click or focus).
      iv.  Wait 2 rAFs; if no new body children, wait up to 2s via MutationObserver.
      v.   If new portal content appeared: walk new elements → append with portal=true, triggeredBy=trigger.selector.
   c. Triggers WITHOUT aria-haspopup: skipped (fast path).
4. Return combined descriptors.
```

### DiscoverOptions

```typescript
interface DiscoverOptions {
  probePortals?: boolean;      // Enable trigger-first portal probing
  remount?: () => Promise<void>; // Reset component state between probes
}
```

### InteractionDescriptor changes

```typescript
interface InteractionDescriptor {
  // ... existing fields
  portal?: boolean;        // true if element lives outside #root
  triggeredBy?: string;    // CSS selector of the trigger that revealed this element
}
```

### Explorer changes

- Initial state discovery calls `discoverInteractions(page, { probePortals: true, remount })`.
- Subsequent state discoveries use basic `discoverInteractions(page)` (body walk only, no probing) for performance.
- Portal interactions are exercised and traced identically to `#root` interactions.

### Report changes

- `InteractionReport` gains `portal?: boolean`.
- Terminal table: portal interactions displayed with `[portal]` suffix on the label.
- `buildReport` passes `portal` flag from `InteractionDescriptor` through to `InteractionReport`.

## Test count

33 new tests (7 unit portal + 8 unit portal-harden + 8 e2e portal + 10 e2e portal-harden).
