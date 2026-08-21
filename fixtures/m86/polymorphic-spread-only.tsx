import React from "react";

// M86: same polymorphic shape as polymorphic-handler.tsx, but the component
// body never references `onClick` by name — only a bare `{...props}` spread
// — so the source-reference mechanism (Tier 0) cannot promote it. This
// isolates whether the type-flow handler check (Tier 2, `propRank`'s
// EVENT_HANDLER_NAME + call-signature test) ranks `onClick` correctly on
// its own for a polymorphic generic element type.
type IntrinsicElements = React.JSX.IntrinsicElements;

interface TableOwnProps {
  variant?: "solid" | "outline";
}

export type TableRootProps<E extends keyof IntrinsicElements = "div"> = TableOwnProps &
  { as?: E } & Omit<IntrinsicElements[E], keyof TableOwnProps | "as">;

export function TableRoot<E extends keyof IntrinsicElements = "div">(props: TableRootProps<E>) {
  return <div {...props} />;
}
