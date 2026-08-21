import React from "react";

// dub's Table shape: a required prop whose type is a class-like interface, so
// synthesis can only produce a placeholder object that the component then calls
// methods on.
export interface TableInstance {
  getVisibleLeafColumns(): string[];
  getRowModel(): { rows: string[] };
  options: { data: string[] };
}

export interface RequiredObjectTableProps {
  table: TableInstance;
  caption?: string;
}

export function RequiredObjectTable({ table, caption }: RequiredObjectTableProps) {
  return React.createElement("div", null, caption, table.getVisibleLeafColumns().length);
}
