import React from "react";

interface CoordProps {
  position: [number, number];
  label?: string;
}

export function Marker({ position, label }: CoordProps) {
  return (
    <div className="marker" data-x={position[0]} data-y={position[1]}>
      {label ?? `(${position[0]}, ${position[1]})`}
    </div>
  );
}
