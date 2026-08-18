import React, { createContext, useContext } from "react";

const ThemeContext = createContext<{ accent: string } | null>(null);

// The missing-provider pattern: every mount throws, nothing renders, and no
// Playwright timeout occurs — the run used to report PASS with 0 DOM nodes.
export function ThemedBadge() {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error("ThemedBadge must be rendered inside a ThemeProvider");
  return <span style={{ color: theme.accent }}>badge</span>;
}

export default ThemedBadge;
