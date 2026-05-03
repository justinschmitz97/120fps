---
kind: milestone
status: done
tests: [test/unit/stress-patterns.test.ts, test/unit/stress-patterns-harden.test.ts, test/unit/report.test.ts]
---

## Purpose

The explorer exercises every interaction identically: one click/type/fill per edge, repeated N times for sampling. This misses dominant real-world performance patterns — rapid toggling, keyboard sweep navigation, hover sweep across sibling rows, open/close cycling of popups, and multi-keystroke typing. M10 adds type-specific stress patterns dispatched by `InteractionDescriptor.type` and `.role`, exposing performance cliffs that single-shot exercises cannot reveal.

## Builds on

M9 (portal-aware discovery). Discovery already categorizes descriptors with `type` (`click`|`type`|`select`|`focus`|`keyboard`|`hover`) and `role` (`accordion`|`tab`|`menu`|`dialog`|`listbox`|`combobox`|`tree`). M10 uses these classifications to select a stress pattern per interaction without changing discovery itself.

## Contract

### MUST

- New module `src/stress-patterns.ts` exporting:
  - `StressStep`: `{ action: "click"|"type"|"fill"|"keyboard"|"hover"|"focus"|"select"; selector: string; key?: string; text?: string; repeat?: number }`.
  - `StressPattern`: `{ name: string; steps: StressStep[] }`.
  - `resolveStressPattern(descriptor: InteractionDescriptor, siblingSelectors?: string[]): StressPattern` — pure dispatch function.
  - `executeStressPattern(page: Page, pattern: StressPattern): Promise<void>` — runs steps in the browser.
  - `findAriaGroupSiblings(page: Page, descriptor: InteractionDescriptor): Promise<string[]>` — queries siblings within ARIA containers.
- Pattern library (dispatched by `type` + `role`, first match wins):
  1. `role` in `[tab, listbox, combobox, menu, tree]` AND `siblingSelectors.length > 0` → **keyboard-sweep**: focus element, ArrowDown × siblingCount, Home, End.
  2. `type === "hover"` AND `siblingSelectors.length > 0` → **hover-sweep**: hover each sibling sequentially.
  3. Descriptor triggers a portal (`role === "dialog"` or `triggeredBy` set) → **open-close-10**: 10 cycles of click-open then click-close. Note: `aria-haspopup="dialog"` is mapped to `role: "dialog"` by discovery's `inferAriaRole`.
  4. `type === "type"` → **multi-keystroke**: focus, type `"abcde12345"` one key at a time.
  5. `type === "click"` → **rapid-toggle-10**: 10 clicks on same selector.
  6. All others → **single-shot**: one exercise (matches current M9 behavior).
- Explorer calls `resolveStressPattern` for each interaction during edge exploration. The full pattern executes inside the CDP trace capture, replacing the current single `exerciseInteraction` call. Each of the N samples executes the full pattern.
- Sibling detection: `findAriaGroupSiblings` queries the page for siblings within ARIA containers:
  - `role=tab` → parent `[role=tablist]` → all `[role=tab]` children.
  - `role=option` → parent `[role=listbox]` → all `[role=option]` children.
  - `role=menuitem*` → parent `[role=menu]` → all `[role=menuitem]` children.
  - `role=treeitem` → parent `[role=tree]` → all `[role=treeitem]` children.
  - `type=hover` → parent element → sibling elements with same tag.
- `StateEdge` extended with `stressPattern?: string` recording which pattern was applied.
- `InteractionReport` extended with optional `stressPattern?: string`.
- Terminal table shows pattern name in parentheses after interaction label when not `"single-shot"`.

### MUST NOT

- Change discovery logic or `InteractionDescriptor` fields.
- Change sample count or measurement infrastructure.
- Add new CLI flags. Stress patterns are always-on; backward compatible via single-shot fallback.
- Break existing state graph structure. Stress pattern edges reuse `StateEdge` schema.

### Invariants

- Components with no ARIA roles produce identical results to M9 (all interactions get `single-shot`).
- `resolveStressPattern` is pure: deterministic for the same descriptor + siblings.
- Stress pattern execution uses the same rAF settle between sub-steps as current interaction exercise.
- All existing tests pass unchanged.

## Design

### Pattern resolution

```
resolveStressPattern(descriptor, siblingSelectors?)
  1. Check role → keyboard-sweep (if siblings available)
  2. Check type=hover → hover-sweep (if siblings available)
  3. Check portal trigger → open-close-10
  4. Check type=type → multi-keystroke
  5. Check type=click → rapid-toggle-10
  6. Fallback → single-shot
```

### Sibling detection

```typescript
async function findAriaGroupSiblings(
  page: Page,
  descriptor: InteractionDescriptor,
): Promise<string[]>
```

Runs `page.evaluate` to find the ARIA container parent, then returns CSS selectors for all sibling items. Returns empty array when no container found (triggers single-shot fallback).

### Explorer integration

In `exploreCombo()`, the interaction exercise call becomes:

```
const siblings = await findAriaGroupSiblings(page, interaction);
const pattern = resolveStressPattern(interaction, siblings);
await executeStressPattern(page, pattern);
// edge.stressPattern = pattern.name
```

### Step execution

Each `StressStep` maps to a Playwright action:
- `click` → `page.click(selector)` (repeated if `repeat` set)
- `keyboard` → `page.keyboard.press(key)`
- `hover` → `page.hover(selector)`
- `type` → `page.keyboard.type(text, { delay: 0 })`
- `focus` → `page.focus(selector)`
- `fill` → `page.fill(selector, text)`
- `select` → `page.selectOption(selector, text)`

Double-rAF settle (`page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))`) after each step.

### Report

`InteractionReport.stressPattern` passes through from `StateEdge.stressPattern`. `formatTable` appends ` (rapid-toggle-10)` etc.

## Test count

50 new tests (25 unit + 22 unit-harden + 3 report integration). 520 total (371 unit + 149 e2e).
