import React from "react";

// M86: a required own prop (`config`) must never be dropped by the cap, and
// `onClick` — inherited purely through `MergedHTMLAttributes`, never
// redeclared locally — must survive because the component's own body
// references `props.onClick` by name, not because of anything about its
// type. `ButtonHTMLAttributes` alone carries far more than 32 DOM boolean/
// union attributes (Tier 1 "variant surface"), so even correct tiering would
// otherwise push both past the cap on volume alone.
export interface ChartConfig {
  color: string;
  label: string;
}

type MergedHTMLAttributes = Omit<
  React.HTMLAttributes<HTMLElement> & React.ButtonHTMLAttributes<HTMLElement>,
  "color"
>;

export interface WidgetProps extends MergedHTMLAttributes {
  config: ChartConfig;
  loading?: boolean;
}

export function Widget(props: WidgetProps) {
  return (
    <button onClick={(e) => props.onClick?.(e)} disabled={props.loading}>
      {props.config.label}
    </button>
  );
}
