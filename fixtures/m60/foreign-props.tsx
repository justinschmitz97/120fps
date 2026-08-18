import React from "react";
import type { AddressInfo } from "node:net";

// Every member of the props type is declared inside node_modules, exactly as it
// is for a component typed off a design-system primitive.
export function ServerBadge(props: AddressInfo) {
  return (
    <span data-family={props.family}>
      {props.address}:{props.port}
    </span>
  );
}
