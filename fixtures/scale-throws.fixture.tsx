import React from "react";

export default function ThrowScene() {
  return <div>default</div>;
}

export function scale(n: number) {
  if (n > 100) throw new Error("too many items");
  return (
    <div>
      {Array.from({ length: n }, (_, i) => (
        <span key={i}>Item {i}</span>
      ))}
    </div>
  );
}
