import React from "react";

// Self-widening generic: each level's type argument is the previous level
// wrapped again, so no two levels share a type identity and TS's per-identity
// memoization never applies.
export type Wrap<T> = { value: T; next?: Wrap<Wrap<T>> };

export interface WidgetProps {
  data: Wrap<string>;
}

export function Widget(props: WidgetProps) {
  return <div>{String(props.data.value)}</div>;
}
