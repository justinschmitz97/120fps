---
kind: milestone
status: done
depends_on: [m2, m5, m6, m8]
tests:
  - test/unit/react-profiler.test.ts
  - test/unit/react-profiler-report.test.ts
  - test/unit/react-profiler-harden.test.ts
---

# M18 — React optimization detection

Separate pass, own browser, own probe-entry.tsx served by same Vite server. No DevTools extension. Framework detection from PROJECT package.json (react/react-dom in any dep section); missing/unreadable → "react"; `--framework` overrides.

Traps:
- `Page.enable` MUST precede `Page.addScriptToEvaluateOnNewDocument` — injection silently no-ops while Page domain disabled, every fiber snapshot empty. Inject once per browser launch.
- Render counting: onCommitFiberRoot walks whole tree — membership ≠ rendered. React double-buffers: renderCount increments only on fiber identity change; memo fibers (tag 14/15) are cloned even on bailout, so a render additionally requires the child subtree was NOT reused. Fibers keyed by tree path (_debugID/index collide across siblings).
- Memo bailout reports only MEMOIZED components that re-rendered — unmemoized parent-cascade is React by design, not a defect.
- Context probe: component rendered behind `__120fpsStable` memo boundary so the synthetic provider's own re-render can't cascade; fan-out = only actual context readers.
- Name filter (one predicate for all three detectors): probe scaffolding Root/AppRoot/`__120fps` PREFIX (bundlers suffix duplicate names) + compiler cache slots /^_c\d+$/ (`_carousel` stays — user's).
- Callback identity: stable vs fresh reference rerender delta; report >0.5ms, warn >2ms.
- All findings warn, NEVER fail. Analysis is post-pipeline (zero overhead on measurements).
