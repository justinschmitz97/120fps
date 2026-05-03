---
kind: milestone
status: done
tests: [test/unit/animation-detect.test.ts, test/unit/animation-detect-harden.test.ts]
---

## Purpose

M13 introduced tiered budgets with `classifyTier({ domNodeCount, hasPortal, hasScaling, hasAnimation })` but hardcoded `hasAnimation: false`. Components with CSS animations or layout-affecting transitions get the wrong tier — an animated accordion stays T1 instead of T2, a large animated modal gets T4 instead of T3. M14 replaces the placeholder with real browser-based detection after mount.

## Builds on

M13 (tier classification with `hasAnimation` parameter). M2 (mount measurement with `page.evaluate` after mount settle).

## Contract

### MUST

- Export `detectAnimations(page: Page): Promise<boolean>` from `src/measure.ts`. Single `page.evaluate()` checking three signals scoped to `#root`.
- Signal 1 — Web Animations API: `document.getAnimations()` filtered to targets inside `#root`. Catches running CSS animations, in-flight CSS transitions, WAAPI animations. Scoped to avoid Vite overlay false positives.
- Signal 2 — CSS animation-name: walk `#root` descendants, `getComputedStyle(el).animationName !== "none"`. Catches declared keyframe animations even if paused.
- Signal 3 — Layout-affecting CSS transitions: `transition-property` checked against allowlist (`transform`, `opacity`, `height`, `width`, `max-height`, `max-width`, `all`) with pairwise duration check. Excludes trivial color/background transitions.
- Add `hasAnimation?: boolean` to `MountResult` interface.
- In `runMountUnmount`, detect animations after domNodeCount (component mounted + 2-rAF settled), before unmount trace.
- In `measureMount`, capture `hasAnimation` from first sample only (structural property, not sample-dependent).
- In `buildReport()`, read `hasAnimation` from matching `MountResult` for each combo. Replace hardcoded `false`.
- Add `hasAnimation?: boolean` to `ComboReport`. Set when tiered budgets active.
- `formatTable` shows `[anim]` suffix on verdict when `hasAnimation` is true and tier is set.
- Export `detectAnimations` from `src/index.ts`.

### MUST NOT

- Add a separate browser launch or extra mount cycle for detection.
- Detect on every sample — first sample only.
- Change `classifyTier` logic (already correct from M13).
- Detect animations outside `#root` (portal animations are intentionally excluded from this signal).
- Break existing tests.

### Invariants

- `hasAnimation` optional on `MountResult` — undefined defaults to `false` in `buildReport`.
- Detection is deterministic: same component + CSS produces the same result.
- `flatThresholds` mode: `hasAnimation` not used for classification, `ComboReport.hasAnimation` not set.
- A small animated component (≤12 DOM) gets T2 (promoted from T1 due to animation exclusion in T1 rule). T2 does not gate on animation.
- A large animated component (>40 DOM, no portal/scaling) gets T3 (animation triggers T3 rule).

## Design

### Detection function

```
detectAnimations(page):
  return page.evaluate(() => {
    const root = document.getElementById("root")
    if (!root) return false

    // Signal 1: running animations inside #root
    const animations = document.getAnimations()
    if animations.some(a => root.contains(a.effect?.target)):
      return true

    const LAYOUT_PROPS = Set(["transform","opacity","height","width","max-height","max-width","all"])

    for el of root.querySelectorAll("*"):
      const style = getComputedStyle(el)

      // Signal 2: declared keyframe animation
      if style.animationName !== "none":
        return true

      // Signal 3: layout-affecting transition
      if style.transitionProperty !== "none":
        const props = style.transitionProperty.split(",").map(trim)
        const durs = style.transitionDuration.split(",").map(trim)
        for i in 0..props.length:
          if LAYOUT_PROPS.has(props[i]) and durs[i % durs.length] !== "0s":
            return true

    return false
  })
```

### Integration

In `runMountUnmount`, after line 208 (domNodeCount):
```
const hasAnimation = await detectAnimations(page)
```

In `buildReport`, replacing line 145:
```
const mountResult = input.mounts.find(m => m.comboIndex === mount.comboIndex)
const hasAnimation = mountResult?.hasAnimation ?? false
const tier = classifyTier({ domNodeCount, hasPortal, hasScaling, hasAnimation })
combo.hasAnimation = hasAnimation
```

### Terminal table

```
#    Mount    Rerender  Unmount  DOM   Interactions  Scaling   Verdict
---  -------  --------  -------  ----  ------------  --------  ----------------
0    0.82ms   0.31ms    0.15ms   8     2             -         PASS (T2) [anim]
1    3.50ms   1.20ms    0.45ms   45    12            linear    WARN (T3) [anim]
```

## Test count

~40 new tests. ~539 total.
