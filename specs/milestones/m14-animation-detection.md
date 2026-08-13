---
kind: milestone
status: done
tests: [test/unit/animation-detect.test.ts, test/unit/animation-detect-harden.test.ts]
---

# M14 — animation detection

Replaces M13's hardcoded hasAnimation:false. One page.evaluate, three signals, all scoped to #root (Vite overlay outside would false-positive; portal animations deliberately excluded):

1. document.getAnimations() filtered to targets inside #root (running CSS/transition/WAAPI).
2. computed animationName !== "none" (catches declared-but-paused keyframes).
3. transition-property in allowlist {transform,opacity,height,width,max-height,max-width,all} with nonzero duration — duration index `i % durs.length` (CSS repeats short duration lists); excludes color-only transitions.

Non-obvious:
- Detected on FIRST sample only (structural, not sample-dependent); no extra browser/mount cycle.
- After domNodeCount, before unmount trace.
- undefined → false in buildReport; not set in flat-thresholds mode.
- `[anim]` suffix on verdict when tiered.
