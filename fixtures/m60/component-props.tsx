import React from "react";

// Stands in for a design-system primitive: its own props plus the DOM surface.
function SwitchPrimitive(
  props: {
    checked?: boolean;
    onCheckedChange?: (next: boolean) => void;
    orientation?: "horizontal" | "vertical";
  } & React.ButtonHTMLAttributes<HTMLButtonElement>,
) {
  return <button role="switch" aria-checked={props.checked} {...props} />;
}

export function Switch(props: React.ComponentProps<typeof SwitchPrimitive>) {
  return <SwitchPrimitive {...props} />;
}
