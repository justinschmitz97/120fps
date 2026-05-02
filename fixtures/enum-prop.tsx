import React from "react";

export enum Size {
  SM = "sm",
  MD = "md",
  LG = "lg",
  XL = "xl",
}

interface IconProps {
  name: string;
  size?: Size;
  spin?: boolean;
}

export function Icon({ name, size = Size.MD, spin = false }: IconProps) {
  return <i className={`icon icon-${name} icon-${size} ${spin ? "spin" : ""}`} />;
}
