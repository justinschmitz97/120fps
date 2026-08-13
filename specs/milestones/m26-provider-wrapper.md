---
kind: milestone
status: approved
tests: test/unit/m26-wrap.test.ts, test/unit/m26-wrap-harden.test.ts, test/e2e/wrap.test.ts, test/e2e/wrap-harden.test.ts
---

# M26 — provider wrapper

`--wrap <module>` or auto-detect `120fps.setup.{tsx,jsx,ts,js}` at projectRoot (that extension order). Default export = component taking {children}, rendered once around target. Top-level side effects (CSS import, theme class/data-attr, locale registration) are the SUPPORTED theme-selection mechanism. NOT a Storybook loader (ADR 0002) — environment only, no story args, one wrapper per run. `--no-wrap` wins over `--wrap`.

Non-obvious:
- Wrapper import emitted BEFORE the component import — ES module order runs its side effects first, as an app would. Namespace import (`* as`) is what makes `viewport` export optional: a bare named import of a missing export is a link-time SyntaxError in the browser.
- `viewport` read in the BROWSER, not Node — wrapper may import CSS/browser-only packages, unevaluable in Node. Applied per session after readiness, before throttle.
- Wrapper must live inside projectRoot (Vite serves from there); rejected before harness dir creation (no leftover dirs).
- Wrapper is part of the rendered tree ⇒ mount includes provider cost. Chosen over mount-once+swap-children to keep unmount semantics identical to unwrapped path. Compensations: traced `mountWrapperOnly()` overhead pass → Report.wrapper.overheadMs (header shows it, reader subtracts); wrapper-only DOM delta → Report.wrapper.domNodes + warning (shifts tier).
- Static validation rejects only PROVABLY non-callable defaults (literals); memo()/forwardRef()/identifiers/classes accepted — callability undecidable statically. Clear error, not a page timeout.
- scanExternalDeps also runs from the wrapper (union → optimizeDeps.include) with aliases [...tsconfig, ...shims] — else first mount pays Vite on-demand optimize inside a measured sample.
- HarnessResult.component carries identity for the probe; the deleted regex scrape `/from "\/(...)"/` would have resolved the wrapper as the component (latent bug even before M26 — broke on any earlier `from "/…"` import).
- Wrapper throwing at import → readiness timeout enriched via page-errors.
- Calibration stays unwrapped (fixed component-independent yardstick). React probe applies wrapper OUTSIDE its context probe.

Deferred: async `setup()` (MSW seeding) — hanging-setup failure modes; revisit when a real target needs it.
