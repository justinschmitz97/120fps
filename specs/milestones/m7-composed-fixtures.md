---
kind: milestone
status: done
tests: [test/unit/fixture.test.ts, test/unit/fixture-harden.test.ts, test/e2e/fixture.test.ts, test/e2e/fixture-harden.test.ts]
---

# M7 — composed fixtures

`*.fixture.tsx|ts` = self-contained scene, default export, ALWAYS mounted with `{}` (1 combo, no prop extraction). Just a React file — no 120fps imports, no config, never modified.

Non-obvious:
- Adjacent `<stem>.fixture.tsx` auto-detected silently; report records `fixtureAutoDetected`.
- `--fixture <path>`: fixture mounts, component path supplies componentName; `fixturePath` in report.
- Fixture throwing during render degrades, doesn't crash pipeline.
- 0 interactions + no fixture → terminal hint suggesting one.
- Measured identically to auto combos (same tracing/calibration/discovery/verdicts).
