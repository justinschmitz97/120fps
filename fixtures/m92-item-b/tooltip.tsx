import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import React from "react";

// M92 gap 2 fixture (mirrors dub's real packages/ui/src/tooltip.tsx): a thin
// wrapper around a headless-kit primitive -- no local createContext, no
// local throw. Radix's own hook throws outside TooltipPrimitive.Provider,
// not anything defined in this file.
export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return <TooltipPrimitive.Provider delayDuration={150}>{children}</TooltipPrimitive.Provider>;
}

export function Tooltip({ children }: { content: string; children: React.ReactNode }) {
  return <TooltipPrimitive.Root>{children}</TooltipPrimitive.Root>;
}
