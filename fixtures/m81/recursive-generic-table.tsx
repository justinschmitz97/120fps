import React from "react";

// Mirrors element-plus's TableColumnCtx<T> shape: a self-referential generic
// nested through an array member, reached through defineProps-shaped
// composition (TableProps<T> -> TableColumnCtx<T> -> children?: TableColumnCtx<T>[]).
export interface TableColumnCtx<T> {
  label?: string;
  property?: string;
  children?: TableColumnCtx<T>[];
  columns?: TableColumnCtx<T>[];
  getColumnIndex?: () => number;
  realWidth?: number;
  filters?: { text: string; value: T }[];
  render?: (row: T, column: TableColumnCtx<T>, index: number) => unknown;
}

export interface TableProps<T> {
  data: T[];
  columns?: TableColumnCtx<T>[];
  store?: { states: { columns: TableColumnCtx<T>[]; data: T[] } };
}

export interface Node<T> {
  value: T;
  children?: Node<T>[];
}

export interface WidgetProps {
  table: TableProps<Node<string>>;
}

export function Widget(props: WidgetProps) {
  return <div>{props.table.data.length}</div>;
}
