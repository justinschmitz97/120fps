---
kind: milestone
status: implemented
tests:
  - test/unit/m42-preflight.test.ts
  - test/e2e/m42-preflight.test.ts
---

# M42 — server-only import preflight

## Purpose

A component whose import graph reaches server-only code (a `server-only`
import, a `"use server"` module) or that is itself an async server component
cannot mount in a browser harness — permanently, not fixably by configuration.
Without a check that surfaces as a deep Vite transform error or a readiness
timeout minutes into the run. The boundary is legitimate; the experience of
hitting it is not. Fail in seconds, name the chain, say what to do.

## Contract

- `runPreflight({ projectRoot, entries, componentName })` runs after prop
  extraction and before any harness directory or dev server exists.
- Entries are the measured file plus the wrapper when one is active: a
  server-only import reaches the browser through either.
- Hard failures (throw before boot, message carries the import chain):
  - any module in the graph importing `server-only` / `next/server-only`;
  - a `"use server"` directive prologue on any module in the graph;
  - the measured export being an `async` function component (AST check on
    function declarations, `const X = async () => {}`, and
    `export default async`).
- Soft signals (`NODE_BUILTIN_WARNING`, run continues): a Node builtin
  (`node:*` or a `module.builtinModules` name) reached through the graph. Vite
  may externalize it, so this is a lead, not a verdict.
- Type-only edges MUST NOT trigger either class: an `import type` statement, or
  a named import whose specifiers are all `type`, is erased before it reaches a
  browser. A side-effect import (`import "server-only"`) is always runtime.
- The walk stops at package boundaries (`node_modules`, `.d.ts`): a
  dependency's internals are the bundler's problem, and walking them would cost
  more than the check.
- `preflightFailureMessage` reports the first hit — everything below it is
  unreachable until that edge moves — as `chain → specifier`, plus the fix
  ("extract the client part below that boundary, or point 120fps at the client
  child component") and the escape hatch.
- `--no-preflight` (`AnalyzeOptions.noPreflight`) downgrades hard failures to
  `PREFLIGHT_BYPASSED_WARNING`, which names what was skipped. The soft warning
  is not suppressible.

## Design

- Own module (`src/preflight.ts`), no type checker: the question is which
  modules are reachable over runtime edges, which the AST answers. Files are
  parsed with `ts.createSourceFile`; specifiers resolve through
  `ts.resolveModuleName` under `projectCompilerOptions(entry)` — the same
  options prop extraction uses, so tsconfig `paths` behave identically.
- BFS with a parent map; a hit's chain is reconstructed by walking parents back
  to the entry, so the report shows the path a reader can follow.
- `server-only` is matched as a specifier, before resolution: the package need
  not be installed for the boundary to be real.

## Hardening

| # | Hypothesis | Result |
|---|---|---|
| H1 | A missing entry file throws | Pass — unreadable files are skipped |
| H2 | An async export unrelated to the measured component fails the run | Pass — only the measured export is checked |
| H3 | A sync component reads as async | Pass — not flagged |
| H4 | A `"use server"` string outside a directive prologue counts | Pass — prologue only |
| H5 | The walk revisits and diverges on a repeated graph | Pass — stable across runs |
| H6 | A wrapper's own server import is missed | Pass — wrapper is an entry |

## Deferred

- Whether a `"use client"` directive above a server import should downgrade
  descendant hard failures. Plausible (the bundler may never reach the import),
  unverified against a real app-router repo, and wrong in the direction that
  matters: encoding it early would silently pass components that cannot mount.
- Showing every offending chain rather than the first.
