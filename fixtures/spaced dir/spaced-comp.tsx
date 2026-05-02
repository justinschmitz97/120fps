import React from "react";

interface SpacedProps {
  text: string;
  bold?: boolean;
}

export function SpacedComp({ text, bold = false }: SpacedProps) {
  return <span className={bold ? "bold" : ""}>{text}</span>;
}
