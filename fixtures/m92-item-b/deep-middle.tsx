import React from "react";
import { DEEP_STYLES } from "./deep-provider.js";

// A plain passthrough: imports an unrelated named export from
// deep-provider.tsx (not the provider itself), so deep-provider.tsx becomes
// reachable from deep-entry.tsx two hops out, without this file itself
// being provider-shaped.
export function DeepMiddle({ children }: { children: React.ReactNode }) {
  return <div style={DEEP_STYLES}>{children}</div>;
}
