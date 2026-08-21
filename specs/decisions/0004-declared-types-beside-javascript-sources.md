---
kind: decision
status: approved
supersedes: 0002-typescript-only-prop-inference.md
---

## Context

ADR 0002 chose the TypeScript Compiler API as the only source of prop information and recorded the
consequence "Untyped JS components: default props only". That line was written for a `.js` file with
no type information anywhere. It does not describe the dominant authoring convention of published
React libraries: a `.js` implementation shipped beside a hand-written `.d.ts` that every importer of
the module already resolves.

Field test run 4 (`C:\Projekte\120fps-fieldtest\verify\V3-material-ui.md`) measured what ADR 0002
produced for that shape. `packages/mui-material/src/Badge/Badge.js` has `Badge.d.ts` next to it
declaring sixteen props. `--explain-props` reported two: `ref` and `key`. Chip, Tabs and Autocomplete
gave the identical two-prop answer. The mechanism: `React.forwardRef`'s render function takes an
unannotated parameter, so `P` defaults to `{}`, the variable types as
`ForwardRefExoticComponent<RefAttributes<any>>`, and that wrapper's own two attributes were accepted
as the component's contract.

Two things were wrong with that outcome under ADR 0002's own terms. The decision's rationale is "TS
types already present in every typed codebase" — Badge's types are present, one
`ts.resolveModuleName` call away. And the decision promised "default props only"; what it delivered
was two entries that are not props of the component at all.

## Decision

Still TypeScript Compiler API only. Two amendments to ADR 0002's consequences:

1. **A sibling declaration is the component's types.** For a `.js`/`.jsx` entry, `./<stem>` is
   resolved through `ts.resolveModuleName` — the same resolution an importer performs — and the
   exported component's declared type supplies the props, ahead of the type-level fallback that reads
   call signatures off the JS binding. A `types`/`typings` entry resolving to a `.d.ts` counts the
   same way. Nothing changes for a `.ts`/`.tsx` entry: its own source is the contract.

2. **React's ambient attributes are not a props type.** A bound type whose only properties are `ref`
   or `key`, declared in React's own type packages, is treated as unresolved rather than as a
   contract. When the fallback chain then finds nothing, the schema is empty and the run says so
   (`UNTYPED_JS_COMPONENT_WARNING`).

ADR 0002's "Untyped JS components: default props only" is therefore narrowed to JS with no
declaration reachable at all.

## Why

- A wrong contract is worse than a stated empty one. `ref` and `key` produced two identical
  empty-props mounts presented as prop sensitivity (`findings/material-ui.md`, run 7).
- The declaration is the same artifact every consumer of the package type-checks against, so reading
  it keeps "measure what the user's code sees" true without adding a second source of truth.
- Both amendments are pure resolution changes. No runtime evaluation, no manual scenarios, no
  Storybook — ADR 0002's actual decision is untouched.

## Consequences

- A JS entry costs one extra `ts.resolveModuleName` call and, when a declaration is found, one extra
  program root.
- A declaration whose exported type is a generic component interface (MUI's `OverridableComponent`)
  is read through its first call signature, so the props seen are that overload's — including
  `component` for MUI.
- A stale `.d.ts` beside a JS source produces stale props. That is the same staleness every importer
  of the package already has, and it is preferred over React's wrapper attributes.
- JS with no declaration and no typed parameter still extracts nothing, now with a named reason
  instead of a plausible-looking two-prop schema.
