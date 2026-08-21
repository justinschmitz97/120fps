const noop = () => {};

// M96 (calcom-F2): a real (non-type-only) runtime export in Next.js — the
// class useSearchParams() returns. Mirrors real Next.js's own shape: a
// URLSearchParams subclass whose mutating methods throw, so a component that
// does `instanceof ReadonlyURLSearchParams` or attempts a mutation sees the
// same contract it would against the real module.
export class ReadonlyURLSearchParams extends URLSearchParams {
  append(): never {
    throw new TypeError("ReadonlyURLSearchParams cannot be mutated");
  }
  delete(): never {
    throw new TypeError("ReadonlyURLSearchParams cannot be mutated");
  }
  set(): never {
    throw new TypeError("ReadonlyURLSearchParams cannot be mutated");
  }
  sort(): never {
    throw new TypeError("ReadonlyURLSearchParams cannot be mutated");
  }
}

export function useRouter() {
  return { push: noop, replace: noop, back: noop, forward: noop, refresh: noop, prefetch: noop, pathname: "/" };
}

export function usePathname() { return "/"; }
export function useSearchParams() { return new ReadonlyURLSearchParams(); }
export function useParams() { return {}; }
export function useSelectedLayoutSegment(): string | null { return null; }
export function useSelectedLayoutSegments(): string[] { return []; }
export function redirect() {}
export function permanentRedirect() {}
export function notFound() {}
export function unstable_rethrow() {}
export function useServerInsertedHTML() {}

export const RedirectType = { push: "push", replace: "replace" } as const;
