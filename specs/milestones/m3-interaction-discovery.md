---
kind: milestone
status: done
tests:
  - test/unit/discovery.test.ts
  - test/e2e/discovery.test.ts
  - test/e2e/discovery-harden.test.ts
---

# M3 — interaction discovery

One page.evaluate DOM walk (TreeWalker) → InteractionDescriptor[]. Deterministic, document order, no DOM mutation, caller owns browser.

Non-obvious:
- Selector priority #id > [data-testid] > nth-of-type chain; each validated `querySelector(sel)===element` before return.
- Only OPEN shadow roots (closed inaccessible — documented limit).
- Skips #root itself, script/style/link, display:none, visibility:hidden, aria-hidden; tabindex="-1" and contenteditable="false" excluded.
- ARIA widget patterns → structured role: accordion (aria-controls→region), tabs, menu, dialog (trigger via aria-haspopup), listbox, combobox, tree.
- Elements added after mount invisible until next call.
