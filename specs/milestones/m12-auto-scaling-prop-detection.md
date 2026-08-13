---
kind: milestone
status: done
tests:
  - test/unit/auto-scale.test.ts
  - test/unit/auto-scale-cli.test.ts
  - test/unit/auto-scale-report.test.ts
  - test/unit/auto-scale-harden.test.ts
---

# M12 — auto-scaling prop detection

Zero-config scaling: name heuristics pick ONE prop. Priority: items-like array (/items|options|data|children|entries|records|elements|list/i) > any array > named numeric (/count|size|length|limit|max|total|depth|level|columns|rows|pages/i) > /^n$|^num/i. Sweep anchor combos at [1,5,20,50].

Non-obvious:
- Manual scale() export and fixture mode always win; auto-scale never runs in fixture mode.
- Array fill was `["item-1"..N]` strings — wrong for typed elements; M30 F2 added elementTemplate.
- Normal combos still measured; scaling is an EXTRA pass. Scale combos informational (forced pass — see M24 D13 test note).
- `--scale` overrides points, `--no-auto-scale` disables. Report records autoScalingProp + reason.
