import React from "react";

interface ComparisonProps {
  images: [string, string];
  origin: [number, number];
  range?: [start: number, end: number];
  mixed: [string, number, boolean];
}

export function ComparisonSlider({ images, origin, range, mixed }: ComparisonProps) {
  return (
    <div data-x={origin[0]} data-y={origin[1]} data-range={range?.join("-")}>
      <img src={images[0]} alt={mixed[0]} />
      <img src={images[1]} alt={String(mixed[1])} />
    </div>
  );
}
