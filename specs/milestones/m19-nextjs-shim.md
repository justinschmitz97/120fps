---
kind: milestone
status: done
tests: [test/unit/nextjs-shim.test.ts, test/unit/nextjs-shim-harden.test.ts]
---

# M19 — Next.js shims

`next` in project deps → Vite aliases map next/image, next/dynamic, next/link, next/navigation, next/headers, next-video/player to self-contained shims (src/shims/ → dist/shims/, import only react). Profiling stand-ins, not polyfills: DOM structure + prop forwarding preserved, framework asset pipeline dropped (plain `<img>`; ±1 node Suspense in dynamic shim ⇒ tier classification unchanged).

Non-obvious:
- tsconfig aliases checked FIRST — user's own next/image alias (e.g. Storybook) wins over shim.
- Deliberately NOT shimmed: next/server, next/config, next/font, next/script — server/build APIs; runtime failure there is informative.
- Report line lists only shims actually reached via scanExternalDeps ∩ shim registry.
- BLOCKED set still strips next pkgs from optimizeDeps; shim aliases handle transform-time resolution.
- `--no-shims` disables; non-Next projects untouched (gated on hasNextJs).
