---
kind: milestone
status: spec
tests: []
---

## Purpose

120fps runs components inside a plain Vite dev server. Components that import Next.js APIs (`next/image`, `next/dynamic`, `next/link`, `next/navigation`, `next-video/player`, etc.) fail because those modules assume a Next.js runtime. M19 adds lightweight Vite aliases that replace Next.js modules with browser-compatible shims so the component mounts and measures without a framework server. The shims preserve DOM structure and prop forwarding — they are profiling stand-ins, not feature-complete polyfills.

## Builds on

M1 (Vite harness, `buildAndServe`, `scanExternalDeps`, `loadTsconfigAliases`). The blocklist added in v0.1.7 already strips Next.js packages from `optimizeDeps.include` — this milestone replaces the runtime modules themselves.

## Contract

### MUST

- Detect when the target project has `next` in its `package.json` dependencies or devDependencies. Set `hasNextJs: boolean` flag in harness setup.
- When `hasNextJs` is true, inject Vite `resolve.alias` entries that map Next.js modules to built-in shim files shipped with 120fps:

  | Module | Shim behavior |
  |--------|--------------|
  | `next/image` | Default-exports a component that renders `<img>` with `src`, `alt`, `width`, `height`, `className`, `style`, and all standard HTML img attributes forwarded. `fill` prop → `style: { position: absolute, inset: 0, width: 100%, height: 100%, objectFit: cover }`. `priority` prop → `loading="eager"`, else `loading="lazy"`. Ignores `loader`, `quality`, `placeholder`, `blurDataURL` (optimization-only). |
  | `next/dynamic` | Default-exports a function `dynamic(importFn, opts?)` that returns a component calling `React.lazy(() => importFn())` wrapped in `React.Suspense` with `opts.loading` as fallback. `ssr` option ignored (always client). |
  | `next/link` | Default-exports a component that renders `<a>` with `href`, `className`, `children`, and standard anchor attributes forwarded. `prefetch`, `replace`, `scroll`, `shallow` props accepted and ignored. |
  | `next/navigation` | Named exports: `useRouter()` → `{ push: noop, replace: noop, back: noop, forward: noop, refresh: noop, prefetch: noop, pathname: "/" }`. `usePathname()` → `"/"`. `useSearchParams()` → `new URLSearchParams()`. `useParams()` → `{}`. `redirect()` / `notFound()` → noop. `useServerInsertedHTML()` → noop. |
  | `next/headers` | Named exports: `cookies()` → `{ get: () => undefined, getAll: () => [], set: noop, delete: noop, has: () => false }`. `headers()` → `new Headers()`. |
  | `next-video/player` | Default-exports a component that renders `<video>` with `src`, `className`, `style`, and standard video attributes forwarded. Passes children through (for `<track>` elements). |

- Shim files live in `src/shims/` and are included in the published `dist/shims/` directory.
- Each shim is a standalone `.js` file with no imports other than `react` (for components) — no build step beyond TypeScript compilation.
- Shim aliases are injected into the Vite `resolve.alias` array in `buildAndServe()`, after tsconfig aliases and before the `dedupe` config.
- Shim aliases only activate when `hasNextJs` is true. Projects without Next.js are unaffected.
- `--no-shims` CLI flag disables all shim injection. `CliArgs.noShims?: boolean`, `AnalyzeOptions.noShims?: boolean`.
- When a shim is active, the terminal report prints a single line: `Next.js shims active: next/image, next/dynamic` (listing only modules actually imported by the component's dependency tree, determined by `scanExternalDeps` results intersected with the shim registry).
- `scanExternalDeps` continues to use the BLOCKED set for `optimizeDeps.include`, but the shim aliases ensure Vite can resolve the modules at transform time.

### MUST NOT

- Shims must not pull in Next.js code. They are self-contained.
- Shims must not alter component behavior beyond removing server-side features. DOM structure, prop forwarding, event handling, and CSS class application must match the Next.js originals as closely as possible for profiling accuracy.
- Shims must not break components that don't use Next.js. The alias injection is gated on `hasNextJs`.
- Do not shim `next/server`, `next/config`, or build-time APIs (`next/font`, `next/script`). These are server/build concerns, not runtime imports. If encountered at runtime, let them fail — the error is informative.
- Do not attempt to replicate Next.js image optimization (srcset, blur placeholder, quality). The shim renders a plain `<img>` — the performance profile reflects the component's React tree cost, not the framework's asset pipeline.

### Invariants

- Shim detection is idempotent: `hasNextJs` is determined once per `buildAndServe()` call from `package.json`.
- Shim alias order: shims are checked after tsconfig path aliases. If the user's project has its own `next/image` alias (e.g., in Storybook), it takes priority.
- A shimmed component produces the same DOM node count (±1 node for Suspense wrapper in `next/dynamic` shim) as the real Next.js component for tier classification purposes.
- Shims work with any React version ≥18 (for `React.lazy` / `Suspense`).

## Design

### Detection

```typescript
function detectNextJs(projectRoot: string): boolean {
  const pkgPath = path.join(projectRoot, "package.json");
  if (!fs.existsSync(pkgPath)) return false;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return "next" in deps;
}
```

### Alias injection

In `buildAndServe()`, after computing tsconfig aliases:

```typescript
const shimDir = path.resolve(__dirname, "shims");
const shimAliases = hasNextJs ? [
  { find: /^next\/image$/, replacement: path.join(shimDir, "next-image.js") },
  { find: /^next\/dynamic$/, replacement: path.join(shimDir, "next-dynamic.js") },
  { find: /^next\/link$/, replacement: path.join(shimDir, "next-link.js") },
  { find: /^next\/navigation$/, replacement: path.join(shimDir, "next-navigation.js") },
  { find: /^next\/headers$/, replacement: path.join(shimDir, "next-headers.js") },
  { find: /^next-video\/player$/, replacement: path.join(shimDir, "next-video-player.js") },
] : [];

// tsconfig aliases first (user overrides), then shims
const resolveAlias = [...alias, ...shimAliases];
```

### Shim: `next/image`

```typescript
import { createElement, forwardRef } from "react";

const Image = forwardRef(function Image(props, ref) {
  const { fill, priority, loader, quality, placeholder, blurDataURL,
          sizes, ...rest } = props;
  const style = fill
    ? { position: "absolute", inset: 0, width: "100%", height: "100%",
        objectFit: "cover", ...props.style }
    : props.style;
  return createElement("img", {
    ...rest,
    ref,
    style,
    loading: priority ? "eager" : "lazy",
  });
});

export default Image;
```

### Shim: `next/dynamic`

```typescript
import { createElement, lazy, Suspense } from "react";

export default function dynamic(importFn, opts) {
  const LazyComponent = lazy(importFn);
  const fallback = opts?.loading ? createElement(opts.loading) : null;
  return function DynamicWrapper(props) {
    return createElement(Suspense, { fallback },
      createElement(LazyComponent, props));
  };
}
```

### Report line

In `formatTable()`, after the machine info block, if the report carries `nextJsShims: string[]`:

```
Next.js shims: next/image, next/dynamic
```

`Report` extended with `nextJsShims?: string[]`. Populated in `buildReport()` from harness metadata.

### File layout

```
src/shims/
  next-image.ts
  next-dynamic.ts
  next-link.ts
  next-navigation.ts
  next-headers.ts
  next-video-player.ts
dist/shims/         (compiled output, included in package "files")
```

`tsconfig.json` already compiles `src/**/*.ts` → `dist/`. No extra build config needed.

## Verification

- Profile `carousel.tsx` from justinschmitz.de → succeeds, reports with `next/image` shim active, Image renders as `<img>`.
- Profile `gallery.tsx` → succeeds via `@/components/Image` → `next/image` shim chain.
- Profile `video.tsx` → `next/dynamic` shim wraps lazy import, `video-internal.tsx` loads and renders.
- Profile `video-internal.tsx` → `next-video/player` shim renders `<video>` with `<track>` children.
- Profile `video-external.tsx` → no shims needed (pure HTML), still works.
- Profile a non-Next.js component (e.g., `button.tsx`) → no shim line in report, behavior identical to pre-M19.
- `--no-shims` flag → carousel.tsx fails with Vite build error (Next.js modules unresolved).
- Shim `<img>` produces same DOM node count as `next/image` `<img>` → tier classification unchanged.
- All existing unit tests pass (shims don't affect non-Next.js paths).
