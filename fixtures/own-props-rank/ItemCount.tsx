import React from "react";

export interface ItemCountProps {
  rowCount?: number;
  max?: number;
}

export function ItemCount({ rowCount, max }: ItemCountProps) {
  return React.createElement("div", { "data-max": max }, rowCount);
}
