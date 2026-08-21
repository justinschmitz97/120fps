import React from "react";

// M84: element-plus-F4. `data: T[]` where `T` is an unbound generic
// parameter cannot resolve an element shape (`synthesizeElement` returns
// undefined); the name "data" matches the same items-like pattern already
// used for scaling detection, so the fallback element must be a real object
// (a component keying a WeakMap on its own rows throws on a primitive key),
// not the generic bare string "item".
export interface TableProps<T> {
  data: T[];
}

export function Table<T>(props: TableProps<T>) {
  const cache = new WeakMap<object, string>();
  for (const row of props.data as unknown as object[]) {
    cache.set(row, "id");
  }
  return <table />;
}
