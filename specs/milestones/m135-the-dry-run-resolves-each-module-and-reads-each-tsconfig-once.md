---
kind: milestone
status: approved
tests:
  - test/unit/preflight.test.ts
  - test/unit/explain-props-parity.test.ts
  - test/unit/module-resolution-is-cached-across-candidates.test.ts
  - test/unit/a-tsconfig-is-parsed-once-per-path.test.ts
---

# M135: the dry run resolves each module and reads each tsconfig once

Lane B, after M130, same worker (`src/project/preflight.ts`, `src/project/model.ts`,
`src/project/tsconfig-aliases.ts`, `src/project/compiler-options.ts`, `src/project/resolve.ts`,
`src/shared/fs.ts`).

## Purpose

`--explain-props` is the command a developer runs first and runs often, and on a large repository it
takes minutes. A CPU profile of posthog's dry run over three candidates spends 28.5 % of its time in
`ts.resolveModuleName` and 27.4 % in `ts.parseJsonConfigFileContent` — that is, 56 % of the run
answering the same two questions repeatedly. Neither call is cached, and the tsconfig parse is handed
the real file system, so every parse expands the project's `include` globs across the whole
repository to produce a file list that only one predicate ever reads. After this milestone each
(module specifier, containing directory) is resolved once per run and each tsconfig is parsed once
per absolute path, and the dry run's output is byte-identical to what it printed before.

Evidence: `C:/Projekte/120fps-fieldtest/smoke/run7-FINDINGS.md` cluster 7, the CPU profile under
`C:/Projekte/120fps-fieldtest/logs/run7-investigate/`, and `smoke/run7-smoke1/posthog.json`
(pass-warn, real 41 s, wall 310 s).

## Root causes (verified)

The verifier for every item below: run-7 investigation (2026-09-06), refuted by default; the sampled
CPU profile of posthog `--explain-props` (3 candidates, 118 s sampled; 266 s cold under two lanes).

1. **Module resolution has no cache and no cross-candidate memory** — `runPreflight`
   (`src/project/preflight.ts:364`) calls `ts.resolveModuleName` at `src/project/preflight.ts:492`
   with four arguments; the fifth, `ts.ModuleResolutionCache`, is omitted. The `seen` set is local to
   one call, so candidates 2 and 3 re-resolve every edge candidate 1 already resolved. The verifier:
   33.5 s of 118 s sampled, 28.5 %, under `runPreflight`.
2. **Both tsconfig readers parse uncached, against the real file system** — `readCompilerConfig`
   (`src/project/model.ts:236`) and `parseTsconfigPathsConfig`
   (`src/project/tsconfig-aliases.ts:188`) each call `ts.parseJsonConfigFileContent`
   (`src/project/model.ts:250`, `src/project/tsconfig-aliases.ts:199`) with the real `ts.sys`, so the
   config's `include` globs are expanded over the whole project on every call. `parsed.fileNames` —
   the only product of that expansion — is consumed by exactly one predicate, `coversTarget`
   (`src/project/model.ts:397`). The verifier: 32.3 s of 118 s sampled, 27.4 %. The stub host that
   avoids the expansion already exists in the codebase at `src/project/compiler-options.ts:45`
   (`{ ...ts.sys, readDirectory: () => [] }`).
3. **File existence is asked repeatedly** — `isFile` (`src/shared/fs.ts:17`), reached through
   `resolveFileWithExtension` (`src/project/resolve.ts`), accounts for 10.3 s of the profile. It is
   the same question asked once per extension per candidate per walk.
4. **The rest is already cheap** — stylesheets 0.2 s, PostCSS 2.1 s. The TypeScript program is
   already rooted at the component (`src/props/program.ts:116-117`); re-rooting it is not the lever
   and would change what is analysed.

## MUST

- **C1** Module resolution inside the project walk is served by a `ts.ModuleResolutionCache` scoped to
  the run and keyed by `(projectRoot, compiler-options key)`, so a specifier resolved from a directory
  once is not resolved from that directory again — including across the candidates of one
  `--explain-props` invocation.
- **C2** `readCompilerConfig` and `parseTsconfigPathsConfig` each memoize by absolute config path for
  the lifetime of the run. Two callers asking for the same config get the same parsed result.
- **C3** Both readers parse with a host whose `readDirectory` returns nothing, so `include` globs are
  not expanded. The one consumer that needs the expansion — `coversTarget`
  (`src/project/model.ts:397`) — obtains the file list lazily, only when it is actually asked, and
  only for the config it is asked about.
- **C4** The dry run's output is unchanged modulo C7's dedupe. For every corpus repository in this
  milestone's acceptance table, `--explain-props` produces the pre-change build's stdout with the
  repeat disclosures C7 removes and nothing else: same props, same order, no line added, no line
  reworded.
- **C5** The real run makes the same decisions it made before, from the same inputs. A cache never
  changes an answer; it only removes a repetition (M100/M110 parity is preserved by construction).
- **C6** The measured effect is recorded: posthog `--explain-props` over the same three candidates is
  at least twice as fast as the pre-change build, measured in the same window on the same machine.
- **C7** A specifier that resolves nowhere is disclosed once per run, not once per candidate. The
  candidate that met it first prints it; later candidates of the same invocation do not repeat it,
  and the same candidate asked twice (the dry run and the real run of one component) prints it both
  times, so dry/real parity is unchanged. The same rule applies to the governing-alias conflict
  disclosure M130 C10 introduced.

## MUST NOT

- Serve a module resolution from the cache for a relative or root-absolute specifier. Those targets
  can appear while the process lives — the harness writes its own entry into the measured project —
  so only bare specifiers, which resolve through `node_modules` and `paths`, are cached.
- Cache across processes, or key a cache on a content hash instead of a path plus `mtimeMs`. M116's
  MUST NOT already forbids both (`m116-…:546-547`), for staleness risk with no measured benefit.
- Re-root the TypeScript program, change which files the program contains, or change the component
  the analysis is rooted at (`src/props/program.ts:116-117`).
- Change any resolution *answer*: the cache is keyed so that two calls that would have produced
  different answers still do.
- Skip `coversTarget`, or make it answer from an unexpanded file list. C3 makes the expansion lazy,
  not optional.
- Hold a cache beyond the run, or share one between two components of a sweep whose compiler options
  differ. The key carries the options.
- Touch the walk semantics M130 established. This milestone runs after M130 in the same lane and
  changes only how often the same question is asked.

## Verification

- **C1** — `test/unit/module-resolution-is-cached-across-candidates.test.ts`: a counting resolver host
  records one resolution per (specifier, containing directory) across three candidates in one
  invocation; two projects with different compiler options do not share entries; the resolved results
  equal the uncached results for a fixture with aliases, `exports` subpaths and an unbuilt sibling.
- **C2, C3** — `test/unit/a-tsconfig-is-parsed-once-per-path.test.ts`: a counting file host records
  one `parseJsonConfigFileContent` per absolute config path; `readDirectory` is not called during a
  parse; `coversTarget` triggers exactly one expansion for the config it is asked about and none for
  the others; the parsed `paths` and `compilerOptions` equal the uncached values.
- **C4, C5** — extend `test/unit/explain-props-parity.test.ts` and `test/unit/preflight.test.ts`: the
  dry run and the real run produce identical decisions and warnings for the M130 fixtures; the
  recorded corpus stdout diff below contains only the repeat lines C7 removes.
- **C7** — `test/unit/a-run-discloses-an-unresolved-package-once.test.ts`: three candidates of one
  project report the unresolvable package once; a second project in the same process reports it
  again; `test/unit/dry-run-names-the-unresolved-prebundle-entry.test.ts` still shows the dry run and
  the real run of one component printing the same line.
- **C6** — recorded below.
- Types: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` clean.
- Suite: the tests above plus `test/unit/tsconfig-*.test.ts`,
  `test/unit/workspace-config-fallback.test.ts`,
  `test/unit/tsconfig-references-select-the-governing-config.test.ts`,
  `test/unit/unbuilt-workspace-source-alias.test.ts`,
  `test/unit/unresolved-alias-reporting.test.ts`, then the full unit suite once before the lane's
  final commit.

Recorded run of this milestone's verification:

```
node node_modules/typescript/bin/tsc -p tsconfig.json          # exit 0

npx vitest run test/unit/module-resolution-is-cached-across-candidates.test.ts   test/unit/a-tsconfig-is-parsed-once-per-path.test.ts   test/unit/a-run-discloses-an-unresolved-package-once.test.ts   test/unit/dry-run-names-the-unresolved-prebundle-entry.test.ts   test/unit/prebundle-entry-that-resolves-to-nothing-warns.test.ts   test/unit/import-graph-walk-parses-each-file-once.test.ts --maxWorkers=2
#   Test Files  6 passed (6)      Tests  27 passed (27)

npx vitest run test/unit --maxWorkers=2          # on the merged wave-1 tree, after review fixes
#   Test Files  2 failed | 364 passed (366)
#   Tests  2 failed | 5180 passed | 1 skipped (5183)
#   the two failures are the recorded baseline pair (prop-cap-ranking.test.ts,
#   vue-setup-inject-evidence.test.ts).
```

Each MUST was confirmed red before its fix: the two new test files failed on the missing
`resetModuleResolutionCache` / `resetPreBuildDisclosures` exports, then on the counts themselves.

Recorded corpus runs, `dist` built in `C:/Projekte/120fps-run7-lane-b`, logs under
`C:/Projekte/120fps-fieldtest/logs/run7-lane-b/`. "Before" is the dist at the M130 commit
(`7001cae`), "after" is the same worktree with this milestone applied, in the same window.

| Repo | Candidates | Before | After | Output |
|---|---|---|---|---|
| posthog | 3 (`m135-posthog-before`, `m135-posthog-after`) | 316 s | 116 s (2.7x) | diff is 36 removed lines, every one a `resolves to no installed package` repeat from candidates 2 and 3; no line added, no line changed |
| librechat | 5 (`m135-librechat-before`, `m135-librechat-after`) | 75 s, 60 unresolved-package lines, 25 alias-conflict lines | 44 s, 12 and 5 | diff adds nothing |
| twenty | 1 (`m135-twenty-dry`, `m130fix-twenty-dry`) | 12 s at the M130 commit | 8-9 s | alias decisions unchanged, 0 stale-alias lines; the only diff after the wave-1 merge is lane C's stylesheet resolution |
| twenty (one walk, measured directly) | `collectStaticPreBuildWarnings` | 5 339 ms, 81 548 `existsSync` | 1 897-2 555 ms, 6 046 `existsSync` | the per-file alias lookup is hoisted out of the specifier loop and the nearest-config walk is memoized per directory |
| plane | 3 (`m135-plane-dry`) | 26 s in `run7-smoke1` | 12 s | — |
| trigger.dev | 3 (`m135-triggerdev-dry`) | 14 s in `run7-smoke1` | 5 s | — |
| taxonomy (control) | 3 (`m135-taxonomy-3`) | 3 s in `run7-smoke1` | 3 s | unchanged |

Corpus repros, through a `dist` built in `C:/Projekte/120fps-run7-lane-b`:

```
node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run6/posthog/frontend \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-b/posthog \
  --label m135-posthog-dry --cli C:/Projekte/120fps-run7-lane-b/dist/cli/main.js \
  -- src/lib/ui/Label/Label.tsx --explain-props
# expected: at least 2x faster than the pre-change build over the same 3 candidates;
#           stdout byte-identical (diff the two logs, minus the timing line)

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories/twenty/packages/twenty-front \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-b/twenty \
  --label m135-twenty-dry --cli C:/Projekte/120fps-run7-lane-b/dist/cli/main.js \
  -- src/modules/ui/input/components/TextArea.tsx --explain-props
# expected: faster, decisions unchanged from the M130 output

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories/taxonomy \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-b/taxonomy \
  --label m135-taxonomy-dry --cli C:/Projekte/120fps-run7-lane-b/dist/cli/main.js \
  -- components/ui/label.tsx --explain-props
# expected: output unchanged, and no slower (baseline dry 3 s)
```

## Deferred

- **Caching `isFile`.** 10.3 s of the profile, but a file-existence cache is the one that goes stale
  inside a run when the harness writes its own entry. Taking it needs an invalidation rule, which C1
  and C2 do not need.
- **Re-rooting or narrowing the TypeScript program.** Explicitly refuted: the program is already
  rooted at the component.
- **Stylesheet and PostCSS work.** 0.2 s and 2.1 s of the profile; not a lever.
- **Caching a relative module resolution.** The one class of target that can appear inside a live
  process; the bare-specifier cache carries the measured win without it.
- **Persisting any cache between invocations.** Forbidden by M116's cross-process clause; a warm dry
  run is a different contract with its own staleness surface.

## Approval

Approved 2026-09-07 on the merged branch feat/run7-remediation (commits `d030e75`, `c5be3ed`).
Adversarial review by an independent agent: needs-fix → fixes → approve. Unit suite on the merged
tree: 391 files / 5455 passed / 2 pre-existing failures / 1 skipped.
