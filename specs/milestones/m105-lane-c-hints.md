---
kind: milestone
status: approved
tests:
  - test/unit/mount-abort-remedy.test.ts
---

# M105 (Lane C half): a mount-phase abort reaches the hint pipeline

Addendum to `m105-every-remedy-names-something-that-exists.md` (Lane A). This file holds **I12**
only — the one M105 MUST whose code lives in Lane C's files (`src/hints.ts`, `src/analyze.ts`).
Lane A's spec links here; nothing in it is edited by Lane C.

## Purpose

Closes primevue-F2. Two different root causes, one symptom: a bare browser stack with zero
remediation text.

```
Error: mount phase failed on combo 0 of Select.vue: page.evaluate: TypeError: Cannot read properties
of undefined (reading 'config')
    at Proxy.$variant (.../packages/core/src/baseinput/BaseInput.vue:31:52)
```

```
Error: mount phase failed on combo 0 of Accordion.vue: page.evaluate: TypeError: this.$slots.default
is not a function
    at Proxy.tabs (.../Accordion.vue:107:39)
```

`BaseInput.vue:30-31` reads `this.$primevue.config.inputStyle`, a global that only
`app.use(PrimeVue)` installs; the harness mounts with a bare `createApp()`. `Accordion.vue:135-136`
calls `this.$slots.default()` as a function with nothing composed into the default slot.

The tool's own hint catalog already covers the first case in words (`hints.ts`'s `renderError`:
"a missing provider needs `--wrap` pointing at a setup module"). It never printed, and the reason is
structural: `hintsForReport` consumes a **built report**, and a mount-phase abort throws before any
report exists — `analyze()`'s outer catch (`analyze.ts:3255`) rethrows with accumulated warnings and
no hints. `PROVIDER_HINT_LINE` does not reach it either: it is preflight-only and keys off static
imports, while `$primevue` is a runtime global, not an import.

## Contract

### MUST

- A mount-phase abort whose page-error text names a Vue injection (`$primevue`, `$slots`, `inject()`,
  `app.use`) or a React provider reaches the same hint pipeline as a render failure, so the failure
  path prints the provider / `--wrap` / slot remedy instead of a bare stack.

### MUST NOT

- Print a remedy that names a flag, file or command this repository does not have (M105's own
  governing rule).
- Guess. A stack that names none of the signatures gets no hint, exactly as `extraHintLines`
  withholds a provider guess when nothing captured looks provider-shaped (M79 4a).

### Invariants

- The hint is appended to the thrown error's message, next to `formatAccumulatedWarnings`'s block,
  so every existing consumer of that message (console, `cli.ts`'s surface-3 handler) shows it
  without a new channel.
- A hint names the window it read: the abort's own message text, never the component's source.

## Design

`src/hints.ts` gains two hint ids alongside `renderError`, because the two Vue causes need
different remedies and `renderError`'s text (a React provider and a `<stem>.props.tsx` preset) is
right for neither:

| id | fires on | remedy named |
|---|---|---|
| `vuePluginGlobals` | `$primevue`, `app.use(`, `inject()`, or `at Proxy.$…` together with a read of `undefined` | `120fps.setup.vue`, installing the plugin from the wrapper's own `setup` through `getCurrentInstance()?.appContext.app.use(...)` — the wrapper renders inside the same app the component mounts in (`generateVueEntry`, `harness.ts:4265-4290`) |
| `vueSlotContent` | `$slots` | `<stem>.fixture.vue` and `--fixture`, the documented path for a compound Vue scene (README `## Vue`) |
| `renderError` (existing) | `provider` / `context` in the text | unchanged |

`hintsForMountAbort(errorText)` returns the matching ids in `HINTS`' own declaration order, and
`formatHints(ids)` — already callable without a report — renders the identical block a completed run
prints. `analyze()`'s outer catch appends it to the message it already builds.

Signature choice, stated because it is the part that can be wrong: the primevue Select abort's text
never contains the string `$primevue` at all (the stack frame reads `at Proxy.$variant`). The
`at Proxy.$` + "Cannot read properties of undefined" pair is what identifies it — a Vue Options-API
member accessed through the component proxy, reading a property of something absent. That pair is
Vue-specific by construction: `Proxy.` frames come from Vue's own component proxy.

## Verification

**Unit.** `pnpm vitest run test/unit/mount-abort-remedy.test.ts` — 7 passed, both primevue abort
texts verbatim from `findings/primevue.md`. `test/unit/hints.test.ts` (20) still passes: both new
hints carry an imperative its copy audit requires and an anchor that exists in the README
(`#provider-wrapper`, `#vue`). `pnpm lint` clean.

**Real repo.** Not re-run. Both primevue repros are full bounded runs against a repo Lane B's M98
work was landing in during this session, so a run now would not isolate this change. The unit
fixtures are the two abort messages verbatim, and the wiring point (`analyze.ts`'s outer catch) is
the single path both aborts take.
