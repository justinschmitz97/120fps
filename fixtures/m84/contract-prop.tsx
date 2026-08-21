import React from "react";

// M84 cross-lane interface: `asChild`'s truthiness imposes a requirement on
// `children` (must be a single valid React element) the synthesizer cannot
// verify it satisfied. Named provenance:"contract" so M85 can decide whether
// a crash while it is truthy is the harness's fault.
export interface SeparatorProps {
  asChild?: boolean;
  children?: React.ReactNode;
}

export function Separator(props: SeparatorProps) {
  return <div>{props.children}</div>;
}
