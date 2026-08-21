import React from "react";

export interface BodyDefaultsButtonProps {
  color?: "primary" | "secondary";
  loading?: boolean;
  tooltipOffset?: number;
}

// calcom's shape: the parameter is a plain identifier and the defaults live in
// a destructuring statement in the body.
export function BodyDefaultsButton(props: BodyDefaultsButtonProps) {
  const { color = "primary", loading = false, tooltipOffset = 4 } = props;
  return React.createElement("button", {
    "data-color": color,
    "data-loading": loading,
    "data-offset": tooltipOffset,
  });
}
