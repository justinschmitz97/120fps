---
kind: milestone
status: implemented
tests:
  - test/unit/m41-setup.test.ts
  - test/e2e/m41-setup.test.ts
---

# M41 — async wrapper setup

## Purpose

M26 explicitly excluded async setup. Components that fetch on mount need
request mocking (MSW or a fetch stub) installed *before* first render, and
data-driven components need seeded stores. Without this, the wrapper solves
context but not data — and M40 correctly flags those components as
`pending-network` forever. This milestone is what turns M40's disclosure
into something the user can act on.

## Contract

- The wrapper module (`120fps.setup.tsx`, M26) MAY export
  `setup: () => void | Promise<void>`. When present, the harness entry awaits
  it before `window.__120fps` is exposed — readiness implies setup completed,
  on the standard, composed, and probe entries alike.
- Setup runs once per browser session (each measurement phase enters a fresh
  context; setup re-runs there). Its cost lands outside every traced window
  and outside calibration.
- Setup failure or timeout (`WRAPPER_SETUP_TIMEOUT_MS`, 15s) rejects module
  evaluation. The control API is never exposed, the rejection is captured by
  `page-errors.ts`, and the run fails with that text attached rather than a
  bare readiness timeout.
- The wrapper MAY export `teardown: () => void | Promise<void>`, exposed as
  `__120fps.teardown()` and called once per measurement session, immediately
  before the session's page is disposed. Best-effort: a throwing teardown or an
  already-closed page never fails a completed measurement.
- `Report.wrapper.hasSetup` is set when a callable `setup` ran. Read from the
  page's control API, not parsed from source. `EnvFingerprint` is unchanged —
  the wrapper file already feeds the M39 source fingerprint, so editing setup
  invalidates cached verdicts.
- MUST NOT: per-combo setup variation, per-sample re-setup, network access
  guarantees (setup that needs a live backend is out of scope — the point is
  mocking).

## Design

- `setupBlock(wrapRelative)` emits a top-level `await` ahead of the control API
  assignment; `setupApiBlock(wrapRelative)` appends `hasSetup` and `teardown`
  after it. Both emit nothing without a wrapper, so a wrapper-less entry never
  references `__120fpsWrapModule` and never gains a top-level await.
- Setup is raced against `WRAPPER_SETUP_TIMEOUT_MS`. An unbounded setup would
  otherwise surface 30s later as a readiness timeout naming the harness.
- The M40 network probe installs in `enterHarness`, i.e. after setup: it wraps
  whatever `fetch` setup left behind, so a stubbed request is measured as the
  stub. Requests issued *by setup* are not attributed to the component.
- Seeded stores (Redux/Zustand/Query cache) need no tool support — the wrapper
  closes over them today.

### Teardown is session-scoped, not per-unmount

The draft placed teardown on `__120fps.unmount()` completion. That is
incorrect: `unmount()` runs once per sample and inside the traced unmount
window, so per-unmount teardown would both pollute the unmount measurement and
dismantle the mocks the remaining samples depend on. Teardown is therefore the
session-scoped counterpart to setup, called from `MeasurementSession.close()`.

## Hardening

| # | Hypothesis | Result |
|---|---|---|
| H1 | Teardown fires between samples and breaks later mounts | Pass — session close only |
| H2 | Teardown on a closed page fails a completed run | Pass — no-op |
| H3 | A wrapper without `teardown` throws on close | Pass — no-op |
| H4 | A wrapper-less entry gains a stray await or module reference | Pass — clean readiness, no page errors |

## Deferred

- MSW service-worker registration: `setupWorker().start()` needs
  `mockServiceWorker.js` served at scope root, and whether registration
  survives the M35 driven-frame session and M37 pooled contexts is unverified.
  The generic mechanism (a `setup` that installs interception) is what ships;
  an MSW-specific path needs a spike against a real MSW project.
- `setup` receiving an argument (e.g. `{ combo }`) — kept out to hold the v1
  contract minimal.
- Setup under StrictMode isolation (`?strict=1`): setup runs once while render
  double-invokes. No double-registration hazard is known, none is verified.
