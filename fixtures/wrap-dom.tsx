import React, { type ReactNode } from "react";

export default function WrapDom({ children }: { children: ReactNode }) {
  return <div className="wrap-surface">{children}</div>;
}
