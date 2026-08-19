import { createElement, type ComponentType } from "react";

const noop = () => {};
const asyncNoop = async () => true;

const router = {
  push: asyncNoop, replace: asyncNoop, back: noop, forward: noop, reload: noop,
  prefetch: async () => {},
  pathname: "/", route: "/", asPath: "/", basePath: "", query: {},
  isReady: true, isFallback: false, isPreview: false, locale: undefined,
  events: { on: noop, off: noop, emit: noop },
};

export function useRouter() { return router; }

export function withRouter<P extends Record<string, unknown>>(Component: ComponentType<P>) {
  return function WithRouter(props: P) {
    return createElement(Component, { ...props, router } as P);
  };
}

export default router;
