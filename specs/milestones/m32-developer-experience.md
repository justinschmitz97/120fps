---
kind: milestone
status: approved
tests: test/unit/m32-expand-paths.test.ts, test/unit/m32-fixture-scaffold.test.ts, test/unit/m32-mode-line.test.ts, test/e2e/m32-cli-paths.test.ts
---

# M32 — developer experience

## Purpose

Three frictions, each observed while running 0.2.1 across six repos rather than imagined. Pointing the tool at a codebase takes a hand-written script. A component whose auto-composition is rolled back leaves the user with a warning and no next step. The report does not say which of its four modes produced the table in front of you, which cost time even while writing the analysis that led to this milestone.

## Non-goals

- Watch mode.
- Parallel component runs. One browser at a time is what makes the numbers comparable; the dogfooding runs showed contention moving timings.
- Storybook story arguments as props. That contradicts ADR 0002 and needs a superseding ADR; it also helps only the one surveyed repo that has stories (54 stories against 155 components; the other three repos have none).

## Contracts

### D1 — a path argument may be a directory or a glob

`src/cli.ts` treats every positional argument as a literal file. PowerShell does not expand globs, so on Windows there is no way to run a directory at all. `justinschmitz.de` carries `scripts/perf-check.mjs` purely to loop 44 components.

- `expandComponentPaths(args, fs)` is pure over an injected filesystem reader and MUST:
  - pass through an existing file unchanged;
  - expand a directory to the component files under it, recursively;
  - expand a pattern containing `*` by matching against the same walk, where `*` matches within one path segment and `**` matches any depth;
  - return results sorted, deduped, and stable across calls.
- A component file is `.tsx` or `.jsx`, and MUST NOT be a test (`.test.`, `.spec.`), a story (`.stories.`), a fixture (`.fixture.`), a declaration (`.d.ts`), or inside `node_modules`, `dist`, `build`, `.next`, or a `.120fps-harness-*` directory.
- An argument matching nothing MUST be a usage error naming the argument, not a silent empty run.
- Ordering MUST be deterministic so a CI log diffs cleanly.

### D2 — a rolled-back composition can be scaffolded

M30 makes a wrong composition visible and tells the user to write a fixture. It should offer the file.

- `--init-fixture` writes `<stem>.fixture.tsx` next to the component when auto-composition was rolled back.
- `buildFixtureScaffold(componentName, exports, tree)` is pure and returns the file contents: an import of the real exports, the tree the inference attempted rendered as JSX with a `TODO` comment per node it could not place, and a default export.
- MUST NOT overwrite an existing file. An existing fixture is either the user's work or a previous scaffold they edited.
- MUST NOT run without the flag. Writing into a project unasked is a side effect the NFRs rule out, and the warning already names the flag.
- The written path MUST be reported so the user can open it.

### D3 — the report states which mode produced it

Curve mode auto-activates on any array prop, empties `report.combos`, and prints a different table. Nothing in the output says so.

- `describeMode(report)` is pure and returns one line naming the mode and, when it auto-activated, why.
- `formatTable` MUST print it directly under the machine line in all four modes.
- The combo mode line MUST state how many combos were measured out of how many were generated, so the M31 cap is visible without reading warnings.

### D4 — the exploration budget is reachable from the CLI

M30 added `totalWallClockMs` and `maxCombos` to `ExploreOptions` with no way to set them.

- `--explore-budget <seconds>` maps to `AnalyzeOptions.exploreBudgetMs`.
- Out-of-range or non-numeric values are usage errors, consistent with `--samples`.

### D5 — `--json` survives expansion

Directory expansion turns one argument into many components, which made M24's parse-time "explicit `--json` with multiple paths is ambiguous" guard unreachable: the flag was silently ignored for all nine components of a real directory run.

- `resolveReportPaths(paths, explicitJsonPath?)` MUST return the exact path for a single component and `<stem-of-json>.<component>.json` for many.
- The parse-time ambiguity error MUST be removed; `--json` now names a destination rather than being rejected.
- Stem collisions keep M24's `-2`, `-3` suffixes.

## Open questions

- Directory mode runs components sequentially, so a 44-component sweep still costs 44 runs. Bounding a whole sweep needs the cheaper sampling plan M31 deferred.
