---
kind: milestone
status: done
tests: [test/unit/delta.test.ts, test/unit/delta-report.test.ts, test/unit/delta-cli.test.ts, test/unit/delta-harden.test.ts]
---

# M11 — pairwise prop delta

"Cost of prop X": hold anchor combo (every prop at values[0]), flip one prop, diff mount/rerender medians. Booleans false→true; unions values[0]→each other (no self-pairs); optional objects undefined→values[0].

Non-obvious:
- Cap 128 pairs; priority booleans > unions ascending value count > objects.
- Already-measured combos reused (JSON.stringify dedupe), not re-measured.
- No deltas for function/reactnode/unknown kinds (no meaningful flip).
- Positive delta = flip slower. Top-level `propDeltas` sorted by |mountDelta| desc.
- `--no-deltas` skips pass (compound-effect detection in M21 then unavailable).
