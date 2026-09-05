const noop = () => {};

// A runtime export in Next.js, so a component's instanceof check has to see this class.
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
