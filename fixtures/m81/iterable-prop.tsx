import React from "react";

// M81 3a: an `Iterable<T>`-typed prop is not a Map/Set, so `collectionValue`
// falls to `opaqueReason`'s generic branch today and synthesizes `{}`, which
// is not a member of `Iterable<T>` and throws inside `new Set(prop)`.
export interface ListProps {
  items: Iterable<string>;
}

export function List(props: ListProps) {
  return (
    <ul>
      {[...props.items].map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}
