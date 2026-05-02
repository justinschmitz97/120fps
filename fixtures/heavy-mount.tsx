import React from "react";

interface HeavyProps {
  iterations?: number;
}

export function HeavyMount({ iterations = 1000 }: HeavyProps) {
  let sum = 0;
  for (let i = 0; i < iterations; i++) {
    sum += Math.sqrt(i) * Math.sin(i);
  }
  return <div className="heavy">{sum.toFixed(2)}</div>;
}
