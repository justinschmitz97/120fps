import React, { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <button onClick={() => setCount((c) => c + 1)}>Increment</button>
      <button onClick={() => setCount((c) => c - 1)}>Decrement</button>
      <span data-testid="count">{count}</span>
    </div>
  );
}
