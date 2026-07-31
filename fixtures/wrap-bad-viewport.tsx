import React, { type ReactNode } from "react";

export const viewport = { width: "375px", height: null };

export default function WrapBadViewport({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
