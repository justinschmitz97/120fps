import React, { type ReactNode } from "react";

export default function WrapExpensive({ children }: { children: ReactNode }) {
  let sum = 0;
  for (let i = 0; i < 400000; i++) sum += Math.sqrt(i);
  return <div className="wrap-expensive" data-sum={sum > 0 ? "1" : "0"}>{children}</div>;
}
