import React, { useState } from "react";

export function Nondeterministic() {
  const [val, setVal] = useState(() => Math.random().toString(36).slice(2, 6));
  return (
    <div>
      <button onClick={() => setVal(Math.random().toString(36).slice(2, 6))}>
        Randomize
      </button>
      <span data-testid="value">{val}</span>
    </div>
  );
}
