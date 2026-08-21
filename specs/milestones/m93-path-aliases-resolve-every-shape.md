---
kind: milestone
status: draft
tests:
  - test/unit/tsconfig-aliases.test.ts
  - test/unit/alias-shape-warnings.test.ts
  - test/unit/wildcard-alias-capture.test.ts
  - test/unit/vite-config-call-expression-alias.test.ts
---

# M93: path aliases resolve every shape TypeScript accepts

## Purpose

`buildPathAliasEntry` (`src/harness.ts`) handles only a trailing `/*` on both sides of a `paths`
entry. A target whose `*` is not the trailing segment is discarded even though it is a genuinely
common monorepo idiom: mantine's `"@mantine/*": ["./packages/@mantine/*/src"]` makes every full run
die on `Failed to resolve entry for package "@mantine/hooks"` — this run's only blocker — and
material-ui's `"@mui/icons-material/*": ["./packages/mui-icons-material/lib/*.mjs"]` resolves to
10,751 real files and is thrown away anyway. `ALIAS_SHAPE_WARNING` then says `one side has a "*" and
the other does not`, which is false for both: each side has exactly one. The source comment claiming
this shape "has no Vite alias that means the same thing" is also wrong — Vite supports a regex `find`
with `$1` capture-group replacement, and the function already builds a `RegExp` for the trailing case.

Separately, chakra-ui's root `vite.config.ts` carries the alias that makes `@chakra-ui/react`
resolvable (`resolve("packages/react/src")`), and it is never read: the config-file parser
(`parseViteConfigFile`) only recognizes a string-literal `resolve.alias` value, so a `resolve(...)`
call-expression value — an extremely common way to write a Vite alias — is silently dropped as
"ignored," never reaching the workspace-root fallback layer M76 already built.

Closes: mantine-F1 (the run's only blocker), mantine-F2, mantine-F3, the material-ui alias warning,
chakra-ui-F1.

## Contract

### MUST

- A `paths` entry with exactly one `*` on each side builds a working alias regardless of where the
  `*` sits in the target, via a capture-group replacement.
- `ALIAS_SHAPE_WARNING` fires only when the wildcard counts genuinely differ, and its text describes
  the actual mismatch.
- The workspace-root `vite.config` is consulted as a disclosed fallback layer when a bare specifier
  fails to resolve through the member's own config.
- An alias that rescues a run is attributable: the warning names the config it came from.

### MUST NOT

- Discard a resolvable alias target.
- Infer "type-only" for a package that has an unbuilt `dist/` but live source.

### Invariants

- `test/unit/tsconfig-aliases.test.ts`'s existing assertions stay byte-identical: every fixture
  target found by `resolveTarget` today keeps resolving the same way.
- The existing trailing-`/*`-both-sides branch (`pattern.endsWith("/*") && target.endsWith("/*")`)
  is untouched: its output is unaffected by this milestone.

## Design

`buildPathAliasEntry` gains a wildcard-count check ahead of the existing shape checks. `countStars`
counts literal `*` occurrences in a string. After the untouched trailing-both-sides branch:

- If `pattern`'s and `target`'s star counts differ, or either has more than one (TypeScript itself
  restricts a `paths` pattern to at most one `*`; more than one on either side is a shape TypeScript
  does not accept, so this is defensive, not a real-world path), `ALIAS_SHAPE_WARNING` fires and no
  alias is built. Its text is generated from the two counts it is given, not a fixed string: "the
  pattern has N wildcard(s) and the target has M" when they differ, or a shape-mismatch phrase when
  they are equal but not exactly one (a shape no valid `paths` entry produces).
- If both have exactly one `*`, `buildWildcardCaptureAlias` splits both strings on their `*` into a
  prefix/suffix pair, resolves the target's prefix/suffix against `base` by substituting a private
  placeholder token for the `*`, running `path.resolve`, then splitting the result back apart on that
  token — correctly handling `.`/`..` segments regardless of where in the target the `*` sits — and
  returns `{ find: RegExp(prefix + "(.*)" + suffix), replacement: absPrefix + "$1" + absSuffix }`.
  Vite's alias replacement (`@rollup/plugin-alias`) substitutes `$1` from a `RegExp` `find`'s capture
  group; the function already builds this kind of `RegExp` for the trailing-both-sides case.
  No loadable-entry check runs on this branch, matching the trailing case today: a wildcard alias
  points at a directory prefix resolved per request, not a single module load.

`parseViteConfigFile`'s `resolve.alias` entry reader (`src/harness.ts`) gains a second value shape
alongside its existing string-literal check: `resolveCallExpressionPath` recognizes a call whose
callee is named `resolve` or `join` (bare identifier or a `path.`-qualified member expression, e.g.
`import { resolve } from "node:path"` then `resolve("packages/react/src")`, or
`resolve(__dirname, "packages/react/src")`). It collects the call's string-literal arguments in
order and resolves them against `configDir` with `path.resolve`; a non-literal argument such as
`__dirname` is simply skipped, because `configDir` is already what `__dirname` would evaluate to
inside that file, so its absence from the collected literals does not change the result. A call whose
literal-argument list is empty, or whose callee is not one of those two names, is left unrecognized
(falls through to today's `ignored.add("resolve.alias")`). This is a text-only, no-execution read:
the same invariant `readViteConfigData`/`parseViteConfigFile` already hold — nothing is imported or
run.

Once this alias resolves, M76's existing workspace-root-fallback layering (`readViteConfigData`)
already merges it in and already fires `VITE_CONFIG_WORKSPACE_ROOT_ALIAS_WARNING`, naming the config
file — no change needed there. This milestone's fix is entirely upstream of that mechanism: it is the
reason the alias was never even parsed out of the file, not a gap in how a parsed alias propagates.

mantine-F3 ("`@mantine/hooks` misclassified as `almost certainly type-only`") closes as a consequence
of the wildcard fix, not a separate code change: once `"@mantine/*": ["./packages/@mantine/*/src"]`
builds a working alias, `@mantine/hooks` resolves as a local, aliased import inside
`resolveLocalImport` before `scanExternalDeps`'s bare-package fallback (the M77 mechanism
`TYPE_ONLY_PACKAGE_WARNING` reads from) is ever reached for that specifier. A verification test pins
this down directly rather than relying on it as an inference.

## Open questions

None: TypeScript's own restriction to at most one `*` per pattern means the "more than one wildcard"
defensive branch above has no real-world fixture to anchor it against; it is covered by a unit test
of the counting logic itself instead of a corpus repro.

## Verification

- Fixture `paths` entries: mid-path wildcard target (`"@mantine/*": ["./packages/@mantine/*/src"]`),
  extension-suffixed target (`"./lib/*.mjs"`), a genuinely mismatched count (wildcard on one side
  only, in both directions), and the control case from `alias-shape-warnings.test.ts` re-asserted
  with corrected wording.
- A workspace-root `vite.config.ts` whose `resolve.alias` value is a `resolve(...)` call expression:
  the alias is parsed, merged via the existing M76 fallback, and disclosed by
  `VITE_CONFIG_WORKSPACE_ROOT_ALIAS_WARNING` naming the root config file.
- The same fixture with a `resolve(__dirname, "...")` two-argument form: identical result.
- A direct test that a workspace-sibling package rescued by the wildcard-capture alias never reaches
  `TYPE_ONLY_PACKAGE_WARNING` at all (mantine-F3).
- `test/unit/tsconfig-aliases.test.ts` in full, unmodified, stays green.
