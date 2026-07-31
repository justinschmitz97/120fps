import React, { type ReactNode } from "react";

export function WrapNoDefault({ children }: { children: ReactNode }) {
  return <div className="wrap-no-default">{children}</div>;
}
