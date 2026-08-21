import * as React from "react";

export interface BadgeOwnProps {
  anchorOrigin?: { vertical: "top" | "bottom"; horizontal: "left" | "right" };
  badgeContent?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  color?: "default" | "primary" | "secondary" | "error";
  invisible?: boolean;
  max?: number;
  overlap?: "rectangular" | "circular";
  showZero?: boolean;
  variant?: "standard" | "dot";
}

export interface BadgeTypeMap<D extends React.ElementType = "span"> {
  props: BadgeOwnProps;
  defaultComponent: D;
}

export interface OverridableComponent<M extends BadgeTypeMap> {
  <C extends React.ElementType>(props: { component: C } & M["props"]): React.JSX.Element | null;
  (props: M["props"]): React.JSX.Element | null;
}

declare const Badge: OverridableComponent<BadgeTypeMap>;

export default Badge;
