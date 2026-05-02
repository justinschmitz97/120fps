import React from "react";

interface LargeDomProps {
  count?: number;
}

export function LargeDom({ count = 500 }: LargeDomProps) {
  return (
    <div className="large-dom">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="item">
          <span>{i}</span>
        </div>
      ))}
    </div>
  );
}
