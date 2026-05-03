import React from "react";

export interface AccordionProps {
  children?: React.ReactNode;
}

export function Accordion({ children }: AccordionProps) {
  return <div data-accordion>{children}</div>;
}
