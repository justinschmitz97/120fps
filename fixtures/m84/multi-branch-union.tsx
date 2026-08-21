import React from "react";

// M84: a multi-branch union that mixes structurally different shapes
// (string vs. a React element; a callback vs. reactnode vs. null) must
// report every branch it collapsed and which one it chose, not silently
// pick one with no disclosure.
export interface HeaderProps {
  label: string | React.ReactElement;
  content: (() => React.ReactNode) | React.ReactNode | null;
}

export function Header(props: HeaderProps) {
  return <div />;
}
