---
kind: milestone
status: implemented
tests:
  - test/unit/m50-ci-surfacing.test.ts
---

# M50 — CI surfacing

## Purpose

CI got an exit code, a terminal table in a log nobody opens, and a JSON file.
Teams adopt perf CI when the regression appears *in the PR*. M22 scoped out
forge integration; the boundary that holds is: 120fps emits formats forges
consume, and never talks to a forge itself.

## Contract

- `--report-md <path>`: GitHub-flavored markdown. Verdict line with component
  and regression counts, one table row per component
  (mount/rerender/verdict/delta-vs-baseline), regressions expanded with numbers,
  a footer naming the machine and the M46 noise level, and `_(cached)_` marks
  for M39 reused verdicts. Works as `$GITHUB_STEP_SUMMARY` content and as a
  PR-comment body; GitLab renders the same file. A multi-component sweep
  produces one file.
- `--report-junit <path>`: JUnit XML, one testcase per component (name =
  repo-relative path), failure body carrying the regression and budget lines.
  Every CI system renders JUnit natively — the cheapest universal integration.
- Both are pure serializers over `Report` only: no measurement state, no
  filesystem reads, no network. They compose with every mode: combo and
  matrix reports render their per-component table unchanged; curve reports
  show the scale-point mount/rerender range and growth class; isolation
  reports show the isolated mount/rerender medians; cached reports are
  labeled `_(cached)_` without fabricating timings. A markdown-only "Mode
  detail" fold expands curve scale points and isolation per-phase numbers
  (M55). Additive-stable like the JSON schema NFR.
- Markdown stays under forge comment limits by construction: the table is
  per-component, regression detail sits behind a `<details>` fold, and the JSON
  file remains the full data reference.
- Both files are written even when components failed — a CI summary that only
  appears on success is the one nobody needed.
- The baseline column distinguishes the states the earlier milestones
  introduced: `skipped (noisy)` (M46), `other machine` (M45), a signed worst
  regression, a best improvement, or `no change`.
- MUST NOT: network calls, forge API tokens, embedded comment-posting. The
  README ships a copy-paste GitHub Actions workflow instead
  (measure → step summary → sticky comment).

## Deferred

- `--report-prev <path>` for deltas against the previous run of the same PR.
  Reviewers would want it; it needs a report-storage story CI does not have yet.
- Exit-code interplay for JUnit consumers: JUnit failure entries plus exit 1
  double-report in some UIs. The README's `continue-on-error` pattern sidesteps
  it; which signal should carry the verdict needs verification against real
  GitHub and GitLab UIs before it is frozen.
