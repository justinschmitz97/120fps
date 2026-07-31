import React from "react";

export interface ChurnThrowsProps {
  variant: "a" | "b";
}

// Renders fine for the first prop set and throws for the second, so a churn run
// hits the failure on its first alternation.
export function ChurnThrows({ variant }: ChurnThrowsProps) {
  if (variant === "b") throw new Error("ChurnThrows: variant b is not renderable");
  return <div data-variant={variant}>ok</div>;
}

export default ChurnThrows;
