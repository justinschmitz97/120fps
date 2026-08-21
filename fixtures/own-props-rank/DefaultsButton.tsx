import React from "react";

export interface DefaultsButtonProps extends React.HTMLAttributes<HTMLButtonElement> {
  color?: "primary" | "secondary" | "minimal" | "destructive";
  variant?: "button" | "icon" | "fab";
  loading?: boolean;
  rounded?: boolean;
}

export function DefaultsButton({
  loading = false,
  color = "primary",
  variant = "button",
  rounded,
  ...rest
}: DefaultsButtonProps) {
  return React.createElement("button", { ...rest, "data-loading": loading, "data-color": color, "data-variant": variant, "data-rounded": rounded });
}
