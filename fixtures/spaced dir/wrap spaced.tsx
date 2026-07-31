import React, { type ReactNode } from "react";

export default function WrapSpaced({ children }: { children: ReactNode }) {
  return <div className="wrap-spaced">{children}</div>;
}
