import React, { createContext, useContext } from "react";

interface WorkbenchValue {
  scale: number;
}

const WorkbenchContext = createContext<WorkbenchValue | null>(null);

export function WorkbenchProvider({ children }: { children: React.ReactNode }) {
  return (
    <WorkbenchContext.Provider value={{ scale: 1 }}>{children}</WorkbenchContext.Provider>
  );
}

export function useWorkbench(): WorkbenchValue {
  const value = useContext(WorkbenchContext);
  if (!value) throw new Error("useWorkbench must be used inside WorkbenchProvider");
  return value;
}
