import React from "react";

// Fixture B (M81 section 5): destructured parameter, no annotation; the type
// is available only through forwardRef's contextual typing.
// `excalidraw/components/FilledButton.tsx:39-55`'s shape.
export interface WidgetProps {
  id: string;
  label?: string;
  count?: number;
  active?: boolean;
}

export const Widget = React.forwardRef<HTMLDivElement, WidgetProps>(
  ({ id, label, count, active }, ref) => {
    return <div ref={ref}>{id}</div>;
  },
);
