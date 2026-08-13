import type { ReactNode } from "react";

export async function setup() {
  throw new Error("m41 setup failed on purpose");
}

export default function WrapSetupThrows({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
