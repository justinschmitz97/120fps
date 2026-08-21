---
kind: milestone
status: draft
tests:
  - test/unit/remedies-name-real-things.test.ts
  - test/unit/preflight-bypass-and-remedies.test.ts
---

# M105: every remedy names something that exists

Lane A (+ I12 in Lane C, specified separately in `specs/milestones/m105-lane-c-hints.md`).
Closes ant-design-F1, nuxt-ui-F2, solid-ui-F1, pnp-app-F1, chakra-ui-F6, taxonomy-F3.

## Purpose

Five messages named something the repository does not have, and one named nothing at all:

- **ant-design-F1** (6 of 6 candidates): `Run \`npm run prepare\` in this project` for a missing
  `components/version/version.ts`. `prepare` is `is-ci || husky && dumi setup`; the script that
  writes that file is `version` (`package.json:105`, `tsx scripts/generate-version.ts`). A user who
  follows the remedy runs git-hook installation and hits the identical crash again.
- **nuxt-ui-F2**: `Try this repository's own \`npm run build\` script` in a repository that declares
  `"packageManager": "pnpm@11.22.0"`, ships only `pnpm-lock.yaml`, and calls `pnpm build` from its
  own scripts.
- **solid-ui-F1**: `Pass --no-preflight to attempt the run anyway.` printed by a run that already
  passed `--no-preflight` — the same output two lines above says so
  (`--no-preflight bypassed 1 ... finding`).
- **pnp-app-F1**: `--no-preflight bypassed 1 server-boundary finding` for a Yarn PnP rejection.
  `preflight.ts`'s own comment already states that PnP and Solid are not server-boundary kinds.
- **chakra-ui-F6**: the alias-source disclosure says where the alias came from and never why it is
  load-bearing: `packages/react/package.json`'s `main`/`module`/`types` all point into a `dist/`
  that does not exist, so without the alias nothing resolves at all.
- **taxonomy-F3**: the env-validation refusal ends after the page errors with no next step, while
  the server-boundary refusal in the same repository ends with a remedy. `NO_ENV_FILE_REMEDY_NOTE`
  exists and is computed for exactly this run; it only ever reached `buildFatalPageErrorMessage`,
  and `waitForReady()`'s own timeout wins that race in practice (`verify/V7`, side finding).

## Contract

- inputs: a failure the harness already diagnosed, plus the repository it happened in.
- outputs: the same diagnosis, with a remedy naming a script, flag or path that exists in that
  repository, invoked through the package manager that repository uses.
- constraints: no new diagnosis and no new failure class; a remedy that cannot be grounded in
  something read from the repository is dropped rather than guessed.
- non-goals: running the remedy, or verifying that the named script actually produces the file.

## MUST (from `specs/milestones/M97-M106-MAP.md`)

- A missing generated file remedy names the `package.json` script whose command references the
  generator or the missing path (ant-design: `npm run version`, `scripts/generate-version.ts`),
  falling back to the build script only when no such script exists; the command uses the detected
  package manager (`pnpm run build` in a pnpm repo, `yarn build` under yarn) — nuxt-ui.
- `--no-preflight` failure text never advises passing `--no-preflight` when it was passed.
- `PREFLIGHT_BYPASSED_WARNING` labels each bypassed kind by its own name (`yarn-pnp`, `solid`,
  `server-boundary`), per `preflight.ts:660`.
- The alias-source warning states when the aliased package's `main`/`exports` point at an absent
  `dist/` (chakra-ui-F6).
- `waitForReadyOrFatal` (`page-errors.ts:284-299`) delivers the fatal signal's remedy when the fatal
  signal arrives before or within the ready timeout: `enrichTimeoutError` accepts the remedy line, so
  `NO_ENV_FILE_REMEDY_NOTE` prints for taxonomy's env-validation throw.

## MUST NOT

- Invent a script name, a flag or a path that was not read from the repository.
- Print the env remedy for a hang that captured no page error at all: with nothing to attribute, a
  suggestion to add an environment variable is a guess.

## Design

**Which script produces the missing file (`src/harness.ts`).**
`findLikelyGenerateCommand(root, missingRelativePath?)` now reads the scripts' *commands*, not only
their names, in three passes: a command that mentions the missing path itself; a command that
mentions a generator for it (a token containing the missing file's stem next to `generate`/`gen`/
`codegen`, which is how `tsx scripts/generate-version.ts` names `components/version/version.ts`);
and only then the existing `CODEGEN_SCRIPT_PRIORITY` name list. The winner is rendered through
`packageManagerRunCommand(root, script)`, which reads `packageManager` first (nuxt-ui's own
`pnpm@11.22.0`), then the lockfile beside the manifest and at the workspace root, and falls back to
npm — `pnpm run build`, `yarn build`, `npm run version`.

**A remedy that was already taken (`src/preflight.ts`, `src/cli.ts`).**
`HARD_REMEDY`'s text is unchanged. `hardRemedyFor(kind)` returns it without the
`Pass --no-preflight to attempt the run anyway.` sentence once `setPreflightBypassed(true)` has been
called, which `main()` does from the parsed flag before any run starts. The flag is process-level
state for the same reason `setCurrentRunProjectRoot` is: the message is built deep inside
`assertReactDomClient`, three call layers below the parsed arguments, and one of its two call sites
lives in another lane's file.

**Naming the kind that was bypassed (`src/preflight.ts`).**
`PREFLIGHT_BYPASSED_WARNING` groups hits by `BYPASS_KIND_LABEL[kind]` (`server-only`/`use-server`/
`async-component` -> `server-boundary`, `unsupported-framework` -> `solid`, `yarn-pnp`,
`not-installed`): one kind reads `bypassed 1 yarn-pnp finding: <chain>`, several read
`bypassed 3 findings (2 server-boundary, 1 solid): <chains>`.

**Why the alias is load-bearing (`src/harness.ts`).**
`aliasedPackageMissingEntry(specifier, projectRoot)` resolves the aliased package's installed
directory and checks the entry its own manifest declares (`exports["."]`'s conditions, then
`module`, `main`, `types`); when the declared entry does not exist on disk, the alias warning gains
a clause naming it. Nothing is claimed when the package is absent, has no manifest, or declares an
entry that exists.

**The remedy that lost a race (`src/page-errors.ts`).**
`enrichTimeoutError` takes a `remedyLine` and appends it when the capture holds at least one page
error — the timeout text stays exactly as it was for a silent hang, which is the case the remedy
would be guessing about. `waitForReadyOrFatal` passes the same lazily-built line it already passes
to `buildFatalPageErrorMessage`, and prefers the fatal message whenever the fatal signal did arrive,
even if the readiness wait rejected first (the observed order for taxonomy).

## Verification

### Unit

`pnpm vitest run test/unit/remedies-name-real-things.test.ts test/unit/preflight-bypass-and-remedies.test.ts`
plus the existing files that cover the same messages.

### Real repositories

Verbatim, from `C:\Projekte\120fps-fieldtest\logs\fix-a-m105-*.log`. Every command is the finding's
own repro.

ant-design-F1 (`components/button/Button.tsx`) — was ``Run `npm run prepare` ``:

```
Error: components/version/version.ts does not exist and is gitignored: it is generated by this
repository's own build/codegen step, not something a plain install produces. Run `npm run version`
in this project, then measure again.
```

nuxt-ui-F2 (`src/runtime/components/Badge.vue`) — was ``Try this repository's own `npm run build` ``:

```
Error: Failed to start Vite dev server in ...\.120fps-harness-6u7r3o: @nuxt/ui imports from
"#imports", a Nuxt build-time virtual module. .nuxt/ already exists, but this module's own generated
templates inside it are still missing: `nuxi prepare` alone did not produce them (a root-level
prepare does not always run every module's own hooks). Try this repository's own `pnpm run build`
script, which builds this kind of module template.
```

solid-ui-F1 (`apps/docs/src/registry/ui/button.tsx --no-preflight --explain-props`) — the
`Pass --no-preflight to attempt the run anyway.` sentence is gone, and the run's own bypass line
names the kind it bypassed:

```
120fps measures React and Vue components; Solid is not supported. Point it at a React or Vue
component, or remove solid-js if this project no longer uses it.
...
  --no-preflight bypassed 1 solid finding: src/registry/ui/button.tsx -> solid-js
```

pnp-app-F1 (`packages/examples/src/04-sortable/simple/Card.tsx --explain-props --no-preflight`) —
was `1 server-boundary finding`:

```
  --no-preflight bypassed 1 yarn-pnp finding: src/04-sortable/simple/Card.tsx
```

chakra-ui-F6 (`packages/react/src/components/badge/badge.tsx --explain-props`):

```
resolve.alias "@chakra-ui/react" -> "E:/repositories/chakra-ui/packages/react/src" came from the
workspace root's E:/repositories/chakra-ui/vite.config.ts, not the project's own vite.config;
without it "@chakra-ui/react" would not resolve at all: its package.json points at
E:/repositories/chakra-ui/packages/react/dist/esm/index.js, which this workspace has not built
```

taxonomy-F3 (`components/ui/badge.tsx --samples 3 --max-combos 2 --explore-budget 20`) — the
refusal ended after the page errors; it now ends with the remedy computed for it all along:

```
Error: component harness did not become ready within timeout. Page errors:
  - X Invalid environment variables: {NEXT_PUBLIC_APP_URL: Array(1)}
  - Invalid environment variables
No .env or .env.local found: 120fps carries a working .env/.env.local injection mechanism, but only
NEXT_PUBLIC_/VITE_-prefixed keys reach the page, and the invoking shell's own environment is never
read. If this failure is a missing environment variable, add it to a .env file at the project or
workspace root.
```

`git status --porcelain` is clean in all six repositories afterwards, with no harness directory and
no `120fps-report.json` left behind.
