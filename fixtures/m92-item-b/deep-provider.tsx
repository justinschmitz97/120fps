import React, { createContext, useContext } from "react";

export const DEEP_STYLES = { color: "blue" };

interface DeepValue {
  active: boolean;
}

const DeepContext = createContext<DeepValue | null>(null);

export function DeepProvider({ children }: { children: React.ReactNode }) {
  return <DeepContext.Provider value={{ active: true }}>{children}</DeepContext.Provider>;
}

export function useDeepContext(): DeepValue {
  const value = useContext(DeepContext);
  if (!value) throw new Error("useDeepContext must be used within DeepProvider");
  return value;
}
