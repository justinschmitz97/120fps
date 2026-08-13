---
kind: milestone
status: done
tests:
  - test/unit/m36-extraction-cache.test.ts
---

# M36 — shared prop-extraction program

## Purpose

`extractProps` and `extractAllProps` build a fresh `ts.Program` per call
(`prop-gen.ts`), re-parsing `lib.d.ts` and the project's `node_modules` type
graph every time — ~0.5–1 s per call on a real Next.js repo. One `analyze()`
run extracts more than once (schemas, curve check, measure fallbacks); a
directory sweep multiplies that by component count. The parsed graph barely
changes between calls: only the component file differs. Cache it for the
process lifetime.

## Contract

- `extractProps` / `extractAllProps` MUST return the same schemas as the
  uncached path for identical inputs — the cache is invisible in outputs.
- Every cached source file is keyed by `(fileName, mtime, size)`; a change to
  any of the three re-parses exactly that file on the next call.
- Program chaining (`oldProgram`) applies only between calls whose resolved
  compiler options are identical; an options change starts a fresh chain.
- No public API change for callers. Test hooks `resetExtractionCache()` and
  `extractionCacheStats()` (`{ programsCreated, sourceFilesParsed }`) are
  exported for determinism in tests and are not part of the report or CLI
  surface.
- Memory: the cache lives for the process (a CLI run is bounded). Test
  processes reset it explicitly where growth matters.

## Design

- A memoizing `CompilerHost` wraps `ts.createCompilerHost(options)`:
  `getSourceFile` consults a module-level map keyed by fileName, validated
  against mtime+size via `ts.sys`. Parsed `lib.*.d.ts` and `node_modules`
  declarations are the dominant cost and are shared across components.
- `lastProgram` is retained per options key and passed as `oldProgram` to
  `ts.createProgram`, so TypeScript's structure-reuse path revalidates the
  cached files instead of re-binding the world.
- The options key is a stable stringify of the resolved compiler options
  (M24: tsconfig is resolved through the TS API, so two components under the
  same tsconfig produce identical options).

## Limits

- `extractAllProps` and `extractProps` share one chain (verified by the
  stats test: the second call re-parses no graph).
- Invalidation is `(mtime, size)` — the same limit TypeScript's own watch
  mode has: an edit that keeps byte length within one mtime tick would read
  stale. No 120fps path edits a component mid-run; tests that rewrite
  fixtures bump mtime explicitly.
