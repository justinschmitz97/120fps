# 120fps

Zero-config React component performance profiler. `npx 120fps ./Component.tsx` → real-browser performance report.

Read `specs/overview/00-tdd.md` for architecture, milestones, and pipeline.

## Development Loop

Every milestone follows this cycle. Do not skip steps.

1. **Spec** — Write the milestone spec first (`specs/milestones/mN-*.md`). Define: purpose, contract (MUST/MUST NOT/invariants), design, open questions. No code yet.
2. **Red test** — Write failing tests that encode the contract. Unit tests for logic, e2e tests for integration.
3. **Implement** — Minimum code to pass the tests. No extras, no abstractions beyond what's needed.
4. **Green** — Run all tests. Fix until green. Update spec if implementation revealed wrong assumptions.
5. **Harden** — Generate 10-20 hypotheses for what could break. For each: create a fixture, write tests, run them. If it fails → fix and re-run all tests. Present results as a table.
6. **Sync docs** — Update ALL specs to reflect current truth. No changelogs, no history. A fresh reader sees only what the system does now.
7. **Condense** — Remove anything from docs that doesn't help future coding sessions.

## Rules

- Specs before code. Tests before implementation.
- Every bug fix gets a test before the fix.
- Specs describe behavior as-is, never as a journal. No changelogs in spec files.
- Hardening is explicit: numbered hypotheses, fixtures, pass/fail table.
- Docs stay in the loop — never "update docs later."
- When a round is done, present full results before moving on.
- No unnecessary abstractions, no feature creep, no premature generalization.

## Tech

- TypeScript, pnpm, vitest, Playwright, Vite, TS Compiler API
- Node >= 20 (but we want to move to 24 if possible)
- Tests: `npx vitest run test/unit/` and `npx vitest run test/e2e/`
- Fixtures: `fixtures/` directory

## Project Structure

```
src/
  prop-gen.ts       — TS Compiler API prop extraction, auto-scaling prop detection, export extraction
  prop-gen-values.ts — value generation + stratified sampling + scaling combo generation
  composition.ts    — auto-composition inference: prefix grouping, suffix taxonomy, template selection
  harness.ts        — Vite harness builder + dev server + composed harness generation
  measure.ts        — CDP trace capture + mount/unmount/rerender timing + animation detection
  metrics.ts        — full CDP metric extraction, INP, scaling curves, calibration, cost attribution
  discovery.ts      — DOM walk for interactive element discovery
  explorer.ts       — exploration loop + state graph builder
  stress-patterns.ts — stress pattern dispatch, step execution, ARIA sibling detection
  react-profiler.ts — framework detection, DevTools hook injection, memo/context/callback analysis, portal hygiene, render attribution
  report.ts         — types, CV, tier classification, verdict logic, terminal table formatting
  analyze.ts        — full pipeline orchestrator (analyze + buildReport)
  cli.ts            — CLI entry point, arg parsing, exit codes
  index.ts          — barrel export
specs/
  overview/         — architecture + glossary
  decisions/        — ADRs (append-only)
  milestones/       — per-milestone specs (transient)
  packages/         — package-level specs (durable)
fixtures/           — test component fixtures
test/
  unit/             — vitest unit tests
  e2e/              — Playwright e2e tests
```
