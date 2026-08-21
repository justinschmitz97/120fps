import React from "react";

// M84: commerce-F1's control. `currencyCode` at the top level of a props
// object synthesizes "USD" (M81 3d); the SAME field one level down inside a
// nested object prop must synthesize the same value, not fall back to the
// generic "test" string placeholder.
export interface LabelShape {
  title: string;
  amount: string;
  currencyCode: string;
}

export interface TileProps {
  label: LabelShape;
}

export function Tile(props: TileProps) {
  return <span>{props.label.title}</span>;
}
