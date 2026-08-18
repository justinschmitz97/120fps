import React from "react";

// A primitive with no declared props: the computed type resolves to `any`, so
// nothing can be enumerated from it.
const OpaquePrimitive = (props: any) => <div {...props} />;

export function OpaqueWidget(props: React.ComponentProps<typeof OpaquePrimitive>) {
  return <OpaquePrimitive {...props} />;
}
