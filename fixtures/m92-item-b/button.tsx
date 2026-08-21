import React from "react";
import { Tooltip } from "./tooltip.js";

interface ButtonProps {
  label: string;
}

export function Button({ label }: ButtonProps) {
  return (
    <Tooltip content={label}>
      <button>{label}</button>
    </Tooltip>
  );
}
