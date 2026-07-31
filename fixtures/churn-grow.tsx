import React, { useRef } from "react";

export interface ChurnGrowProps {
  variant: "a" | "b";
}

// Each render emits more nodes than the last, so rerender N costs more than
// rerender N-1 and alternating props degrades steadily.
export function ChurnGrow({ variant }: ChurnGrowProps) {
  const renders = useRef(0);
  renders.current += 1;
  const rows = renders.current * 50;
  return (
    <div data-variant={variant}>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="row">{i}</span>
      ))}
    </div>
  );
}

export default ChurnGrow;
