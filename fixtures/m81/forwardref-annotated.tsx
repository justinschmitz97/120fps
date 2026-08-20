import React from "react";

// Fixture A (M81 section 5): explicit parameter type annotation on the
// forwardRef callback. `radix-primitives/select.tsx:312-314`'s shape.
export interface WidgetProps {
  id: string;
  label?: string;
  count?: number;
  active?: boolean;
}

export const Widget = React.forwardRef<HTMLDivElement, WidgetProps>(
  function Widget(props: WidgetProps, ref) {
    return <div ref={ref}>{props.id}</div>;
  },
);
