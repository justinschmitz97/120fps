import React from "react";

// M86: heroui-F1's polymorphic-element shape. `TableRootProps<E>`'s only own
// prop is `variant`; everything else spreads from `IntrinsicElements[E]` for
// an unresolved generic `E`. `onClick` must still rank ahead of Tier-3 DOM
// volume (Clipboard/Composition/Focus/Change events, which the real
// `@types/react` declares before Mouse events in source order).
type IntrinsicElements = React.JSX.IntrinsicElements;

interface TableOwnProps {
  variant?: "solid" | "outline";
}

export type TableRootProps<E extends keyof IntrinsicElements = "div"> = TableOwnProps &
  { as?: E } & Omit<IntrinsicElements[E], keyof TableOwnProps | "as">;

export function TableRoot<E extends keyof IntrinsicElements = "div">(props: TableRootProps<E>) {
  return <div onClick={props.onClick as React.MouseEventHandler} />;
}
