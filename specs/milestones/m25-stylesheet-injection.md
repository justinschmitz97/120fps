---
kind: milestone
status: approved
tests: test/unit/m25-css.test.ts, test/unit/m25-css-harden.test.ts, test/e2e/css.test.ts, test/e2e/css-harden.test.ts
---

# M25 — stylesheet injection

Unstyled measurement is a wrong measurement → auto-detection ON by default. detectGlobalCss probes 8 fixed paths (app/globals.css → src/global.css order in code), first existing FILE wins, max one. `--css a,b` explicit (order matters — cascade is load-bearing; no globs, a glob can't define order). `--no-css` wins over `--css` and reproduces pre-M25 behavior.

Non-obvious:
- CSS imports at TOP of entry, before react/wrapper/component imports. Wrapper-imported CSS lands AFTER the --css block ⇒ wrapper wins cascade at equal specificity — matches app layering (wrapper = innermost).
- Out-of-root file → `/@fs/` absolute import (only explicit --css can produce this).
- Vite injects dev CSS during module eval ⇒ `window.__120fps` existing implies styles are in the document; index.html never touched.
- scanExternalDeps deliberately doesn't parse CSS — Vite/PostCSS resolves @import/@plugin at request time, not optimizeDeps.
- Never chdir: some project PostCSS configs resolve plugins against process.cwd().
- `@tailwindcss/vite` loaded from the PROJECT's node_modules (createRequire(projectRoot+"/")); load failure → one warn, run continues. PostCSS config AND plugin both present → BOTH run (plugin appended, never substituted) — project pays for both.
- CSS compile failure → Vite 500 → readiness timeout. hmr.overlay:false so the error hits the console, and page-errors carries the PostCSS message into the enriched timeout.
- Settle gate (one impl, every mounting session, before CPU throttle): fonts.ready bounded 5s → forced layout → 2 rAF. Armed when css OR wrapper active. Font timeout non-fatal → Report.warnings. Nav waits "domcontentloaded" NOT "load" — a stalled webfont blocks load forever; readiness is __120fps, not load. Awaiting readyState complete would be strictly harmful for the same reason.
- Probe entry deliberately uninjected — React findings don't depend on stylesheet (wrapper CSS still reaches it via wrapper import).
- Tier budgets NOT retuned; M29 fingerprint keeps baselines honest. Pre-M25 baseline vs injected run → `incompatible`, comparison skipped by name, no false regressions, no run failure. No blanket "timings not comparable" warning — env warnings are baseline-scoped.
