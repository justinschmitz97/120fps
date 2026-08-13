import type { ReactNode } from "react";

// Async setup that must finish before readiness. The flag proves ordering: the
// harness may not expose its control API until this has run.
export async function setup() {
  await new Promise((r) => setTimeout(r, 20));
  (window as any).__m41SetupRan = true;
}

export function teardown() {
  (window as any).__m41TeardownRan = true;
}

export default function WrapSetupAsync({ children }: { children: ReactNode }) {
  return <div data-testid="wrap-setup">{children}</div>;
}
