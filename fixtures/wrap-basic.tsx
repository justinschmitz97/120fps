import React, { type ReactNode } from "react";
import { WrapContext } from "./wrap-context";

export default function WrapBasic({ children }: { children: ReactNode }) {
  return <WrapContext.Provider value="wrapped">{children}</WrapContext.Provider>;
}
