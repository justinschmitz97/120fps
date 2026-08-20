import React from "react";

// Fixture C (M81 section 5): named function expression, destructured
// parameter, no annotation. Not required by radix or excalidraw, but
// necessary to isolate whether annotation-presence or arrow-vs-named-function
// syntax is the true discriminator for CONFLICT-1.
export interface WidgetProps {
  id: string;
  label?: string;
  count?: number;
  active?: boolean;
}

export const Widget = React.forwardRef<HTMLDivElement, WidgetProps>(
  function Widget({ id, label, count, active }, ref) {
    return <div ref={ref}>{id}</div>;
  },
);
