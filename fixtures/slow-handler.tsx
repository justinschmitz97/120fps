import React, { useState } from "react";

function heavyWork() {
  let sum = 0;
  for (let i = 0; i < 500000; i++) sum += Math.sqrt(i);
  return sum;
}

export function SlowHandler() {
  const [result, setResult] = useState(0);
  const [fast, setFast] = useState(false);
  return (
    <div>
      <button id="slow-btn" onClick={() => setResult(heavyWork())}>
        Slow
      </button>
      <button id="fast-btn" onClick={() => setFast((f) => !f)}>
        Fast
      </button>
      <span>{result}</span>
      {fast && <span>toggled</span>}
    </div>
  );
}
