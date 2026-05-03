import React, { useState } from "react";

export default function StandaloneScene() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <button onClick={() => setCount((c) => c + 1)}>Increment</button>
      <span>Count: {count}</span>
    </div>
  );
}
