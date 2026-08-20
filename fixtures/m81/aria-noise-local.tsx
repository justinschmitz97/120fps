import React from "react";

// Regression guard: NOISE_PROP_NAME (aria-*/data-*) stays a hard, silent,
// pre-cap filter even after M81 — including when declared locally, not just
// when inherited from @types/react.
export interface WidgetProps {
  label: string;
  "aria-describedby"?: string;
}

export function Widget(props: WidgetProps) {
  return <div aria-describedby={props["aria-describedby"]}>{props.label}</div>;
}
