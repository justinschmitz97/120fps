import React from "react";

export function SvgInteractive() {
  return (
    <div>
      <svg width="100" height="100" onClick={() => {}}>
        <circle cx="50" cy="50" r="40" fill="red" />
      </svg>
      <button type="button">Normal button</button>
    </div>
  );
}
