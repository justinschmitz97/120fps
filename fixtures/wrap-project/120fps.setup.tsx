import React, { type ReactNode } from "react";
import { ProjectContext } from "./context";

export default function Setup({ children }: { children: ReactNode }) {
  return <ProjectContext.Provider value="from-setup">{children}</ProjectContext.Provider>;
}
