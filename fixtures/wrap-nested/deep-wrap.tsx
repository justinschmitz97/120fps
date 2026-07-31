import React, { type ReactNode } from "react";

export default function DeepWrap({ children }: { children: ReactNode }) {
  return <div className="deep-wrap">{children}</div>;
}
