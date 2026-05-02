---
kind: milestone
status: done
tests:
  - test/unit/discovery.test.ts
  - test/e2e/discovery.test.ts
  - test/e2e/discovery-harden.test.ts
---

## Purpose
Given a mounted component in Playwright, walk the live DOM to find all interactive elements and categorize them into typed interaction descriptors.

## Contract
### MUST
- `discoverInteractions(page)` accepts a Playwright `Page` (component already mounted) and returns `InteractionDescriptor[]`
- Runs entirely via `page.evaluate()` — single DOM walk, no extra network requests
- Finds interactive elements:
  - Native: `button`, `a[href]`, `input`, `textarea`, `select`, `details > summary`
  - ARIA roles: elements with explicit `role` attribute matching widget roles
  - Tabindex: elements with `[tabindex]` (not `tabindex="-1"`)
  - Contenteditable: elements with `contenteditable` attribute (not `"false"`)
  - Event handlers: elements with `onclick`, `onkeydown`, `onkeyup`, `onkeypress`, `onmousedown`, `onmouseup` attributes
- Recognizes ARIA widget patterns and returns structured descriptors:
  - **Accordion**: `role=button` or `button` controlling `role=region` (via `aria-controls`)
  - **Tabs**: `role=tablist` containing `role=tab` elements
  - **Menu**: `role=menu` containing `role=menuitem`/`menuitemcheckbox`/`menuitemradio`
  - **Dialog**: element with `role=dialog` + its trigger (element with `aria-haspopup=dialog`)
  - **Listbox**: `role=listbox` containing `role=option`
  - **Combobox**: `role=combobox` (input + listbox combination)
  - **Tree**: `role=tree` containing `role=treeitem`
- Each descriptor has: `type` (click | type | select | focus | keyboard | hover), `selector` (CSS), `role` (optional ARIA pattern name), `label` (accessible name), `tagName`
- Generates unique CSS selectors: prefer `#id`, then `[data-testid]`, then positional (`nth-of-type` chain)
- Deduplicates: same element found via multiple paths → single descriptor
- Traverses open shadow DOM (`.shadowRoot` is null for closed roots, so only open roots are traversed)
- Skips `#root` container itself, `<script>`, `<style>`, `<link>`, hidden elements (`display:none`, `visibility:hidden`, `aria-hidden="true"`)
- Returns empty array for component with no interactive elements

### MUST NOT
- Exercise any interactions (M4)
- Capture traces or measure performance (M5)
- Modify the DOM in any way
- Launch browsers — caller provides the page

### Invariants
- Deterministic output: same DOM → same descriptors in same order (document order)
- All selectors returned are valid CSS selectors that `document.querySelector()` can resolve
- No descriptor references an element inside a closed shadow root

## Types

```typescript
type InteractionType = "click" | "type" | "select" | "focus" | "keyboard" | "hover";

interface InteractionDescriptor {
  type: InteractionType;
  selector: string;
  tagName: string;
  label: string;        // accessible name (aria-label, textContent, or "")
  role?: string;        // ARIA widget pattern: "accordion" | "tab" | "menu" | "dialog" | "listbox" | "combobox" | "tree"
  inputType?: string;   // for input elements: text, checkbox, radio, range, etc.
}
```

## Design

### DOM walk (`src/discovery.ts`)
- Single `page.evaluate()` call that runs the entire walk in-browser
- `TreeWalker` with `NodeFilter.SHOW_ELEMENT` for efficient traversal
- For each element: check tag, role, tabindex, event handler attributes
- Shadow DOM: when `el.shadowRoot` exists, recurse into it
- Collect raw element data (tag, attributes, rect) in-browser, compute selectors in-browser
- Return serializable array (no DOM references cross the Playwright boundary)

### Selector generation
- Priority: `#id` → `[data-testid="..."]` → positional (`nth-of-type` chain)
- Validate each selector via `document.querySelector(sel) === element` before returning

### ARIA pattern recognition
- After base walk, scan for ARIA landmark patterns
- Tab pattern: find `[role=tablist]`, collect child `[role=tab]` elements, return one descriptor per tab
- Menu pattern: find `[role=menu]`, collect child `[role=menuitem]` elements
- Dialog pattern: find `[role=dialog]`, find trigger via `[aria-haspopup=dialog]`
- Accordion: find elements with `aria-controls` pointing to `[role=region]`

### Interaction type inference
| element | type |
|---|---|
| `button`, `a[href]`, `summary`, `[role=button]`, `[role=tab]`, `[role=menuitem]` | click |
| `input[type=text]`, `input[type=email]`, `input[type=password]`, `input[type=search]`, `input[type=url]`, `input[type=tel]`, `input[type=number]`, `textarea`, `[role=combobox]` | type |
| `select`, `[role=listbox]` | select |
| `input[type=checkbox]`, `input[type=radio]`, `input[type=range]` | click |
| `[role=treeitem]` | click |
| `[contenteditable]` (not `"false"`) | type |
| elements with only `tabindex` | focus |
| elements with only `onkeydown`/`onkeypress`/`onkeyup` | keyboard |

## Open
- Closed shadow DOM is inaccessible from JavaScript — we skip it and document the limitation
- Dynamic elements added after initial mount are not discovered until next call
