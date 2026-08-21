import React from "react";

export interface NumberBoundsProps {
  min?: number;
  max?: number;
  step?: number;
  largeStep?: number;
  smallStep?: number;
}

export function NumberBounds({ min, max, step, largeStep, smallStep }: NumberBoundsProps) {
  return React.createElement("input", { type: "number", min, max, step, "data-large": largeStep, "data-small": smallStep });
}
