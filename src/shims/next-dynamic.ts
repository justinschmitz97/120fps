import { createElement, lazy, Suspense } from "react";

export default function dynamic(
  importFn: () => Promise<{ default: React.ComponentType<any> }>,
  opts?: { loading?: React.ComponentType; ssr?: boolean },
) {
  const LazyComponent = lazy(importFn);
  const fallback = opts?.loading ? createElement(opts.loading) : null;
  return function DynamicWrapper(props: Record<string, unknown>) {
    return createElement(Suspense, { fallback }, createElement(LazyComponent, props));
  };
}
