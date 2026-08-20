import React from "react";

// M81 section 2, isolated from the cap: total prop count stays under 32, so
// only the noise-filter mechanism is exercised, not cap ordering.
// `TagProps.children` (via `extends React.HTMLAttributes<HTMLSpanElement>`)
// and `onClick` are real @types/react-declared members reached through a
// homomorphic `Pick` over a concrete interface, so their declaration nodes
// still point into `node_modules/@types/react`.
export interface TagProps
  extends Pick<React.HTMLAttributes<HTMLSpanElement>, "children" | "onClick" | "className"> {
  color?: string;
  closable?: boolean;
}

export function Tag({ children, onClick, className, color, closable }: TagProps) {
  return (
    <span className={className} onClick={onClick} data-color={color} data-closable={closable}>
      {children}
    </span>
  );
}
