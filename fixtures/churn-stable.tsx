import React from "react";

export interface ChurnStableProps {
  variant: "a" | "b";
}

// Constant render cost regardless of how many alternations preceded it: the
// control against which ChurnGrow's degradation is read.
export function ChurnStable({ variant }: ChurnStableProps) {
  return (
    <div data-variant={variant}>
      {Array.from({ length: 50 }, (_, i) => (
        <span key={i} className="row">{i}</span>
      ))}
    </div>
  );
}

export default ChurnStable;
