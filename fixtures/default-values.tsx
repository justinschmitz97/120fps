import React from "react";

interface ListProps {
  items?: string[];
  separator?: string;
  maxItems?: number;
}

export function List({ items = ["a", "b", "c"], separator = ", ", maxItems = 5 }: ListProps) {
  return <span>{items.slice(0, maxItems).join(separator)}</span>;
}
