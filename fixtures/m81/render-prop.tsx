import React from "react";

// M81 3b: Base UI's `render` idiom. `isReactNodeType` currently classifies
// this union as "reactnode" on the strength of the `ReactElement` member,
// which then gets a placeholder *string* — but the component calls
// `React.isValidElement(render)` on it, which a string fails.
type ComponentRenderFn<P> = (props: P, state: unknown) => React.ReactElement;

export interface WidgetProps {
  render?: React.ReactElement | ComponentRenderFn<{ className?: string }>;
}

export function Widget(props: WidgetProps) {
  if (!props.render) return null;
  if (React.isValidElement(props.render)) return props.render;
  return null;
}
