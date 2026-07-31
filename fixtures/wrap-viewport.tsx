import React, { type ReactNode } from "react";
import { WrapContext } from "./wrap-context";

export const viewport = { width: 375, height: 667 };

export default function WrapViewport({ children }: { children: ReactNode }) {
  return <WrapContext.Provider value="mobile">{children}</WrapContext.Provider>;
}
