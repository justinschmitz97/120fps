import React from "react";
import { Menu } from "./menu.js";
import { Tooltip } from "./tooltip.js";

interface ButtonProps {
  label: string;
}

export function ButtonWithMenu({ label }: ButtonProps) {
  return (
    <Menu>
      <Tooltip content={label}>
        <button>{label}</button>
      </Tooltip>
    </Menu>
  );
}
