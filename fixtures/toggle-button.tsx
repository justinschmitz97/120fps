import React, { useState } from "react";

export function ToggleButton() {
  const [on, setOn] = useState(false);
  return (
    <div>
      <button onClick={() => setOn((prev) => !prev)}>Toggle</button>
      {on && <div data-testid="panel">Active content</div>}
    </div>
  );
}
