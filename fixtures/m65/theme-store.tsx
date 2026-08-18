import React, { createContext, useContext } from "react";

const ThemeContext = createContext<string>("light");

export function useTheme(): string {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return <ThemeContext.Provider value="light">{children}</ThemeContext.Provider>;
}
