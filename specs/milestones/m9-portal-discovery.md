---
kind: milestone
status: done
tests:
  - test/unit/portal.test.ts
  - test/unit/portal-harden.test.ts
  - test/e2e/portal.test.ts
  - test/e2e/portal-harden.test.ts
---

# M9 — portal discovery

Walk body children beyond #root (dedupe vs #root; filter SCRIPT/STYLE/LINK/NOSCRIPT + Vite overlay). Portal descriptors carry `portal:true` + `triggeredBy`.

Non-obvious:
- Trigger-first probing ONLY for aria-haspopup triggers (others fast-path skipped): remount → snapshot body child count → exercise → 2 rAF (sync portals) then MutationObserver ≤2s (async portals).
- Probe only at initial-state discovery; later states body-walk only (perf).
- Always-open portals found in phase-1 body walk without probing.
- Multiple/nested portals supported.
