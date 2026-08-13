import type { ReactNode } from "react";

// The point of M41: mock the request before first render so a connected
// component measures its settled scene instead of its loading state.
export function setup() {
  window.fetch = (async () =>
    new Response("stubbed", { status: 200 })) as typeof window.fetch;
}

export default function WrapSetupStubFetch({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
