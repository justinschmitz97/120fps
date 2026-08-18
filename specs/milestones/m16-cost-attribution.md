---
kind: milestone
status: done
tests:
  - test/unit/cost-attribution.test.ts
  - test/unit/cost-attribution-report.test.ts
  - test/unit/cost-attribution-cli.test.ts
  - test/unit/cost-attribution-harden.test.ts
---

# M16 — cost attribution

Scripting time → source buckets from call-stack URLs in FunctionCall/EvaluateScript/v8.compile (fallback: stackTrace.callFrames[0].url). Buckets: node_modules package | "react" (react/react-dom/scheduler/jsx-runtime merged) | "user" (project-relative) | "browser" | unattributed. Pure trace post-processing on existing mount traces — no extra capture, no extra CDP categories (devtools.timeline already carries stacks with v8.execute).

Non-obvious:
- Vite URL munging: strip ?v=/?t=, resolve /@fs/, and reverse .vite/deps underscore-joined names (`@radix-ui_react-accordion.js`).
- Nesting-stack dedupe: child span subtracted from parent's attribution (React→Radix→motion never double-counts).
- No source maps required (v1). Layout/paint/style-recalc never attributed (no meaningful stacks).
- Window: `attributeCost` takes a combo's per-sample mount traces and reports the **mean scripting time inside one mount**, so the breakdown is comparable to the Mount column beside it (M66). `sampleCount` and `totalScriptingMs` carry the window and the raw sum.
- Invariant: sum(buckets)+unattributed ≤ totalScriptingDuration of one mount; sum(buckets) = totalScriptingMs / sampleCount.

Open: attribute interaction traces too?; merge @radix-ui/* scopes? (per-package chosen — identifies the expensive primitive).
