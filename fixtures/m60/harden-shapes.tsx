import React from "react";

interface TreeNode {
  label: string;
  child?: TreeNode;
}

interface Grid {
  layout: "grid";
  cols: number;
}

interface List {
  layout: "list";
  dense: boolean;
}

enum Size {
  Small = "sm",
  Large = "lg",
}

interface Wrapped {
  size: Size;
  when: Date;
  index: Map<string, number>;
}

interface HardenProps {
  tree: TreeNode;
  either: Grid | List;
  deep: { a?: { b?: { c?: string } } };
  frozen: readonly { id: number }[];
  wrapped: Wrapped;
  when: Date;
  pattern: RegExp;
  lookup: Record<string, number>;
  none: [];
  rest: [string, ...number[]];
  rows: { id: number; title: string }[];
}

export function HardenShapes(props: HardenProps) {
  return <div data-rows={props.rows.length}>{props.tree.label}</div>;
}
