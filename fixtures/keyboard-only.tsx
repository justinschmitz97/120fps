import React from "react";

export function KeyboardOnly() {
  return (
    <div>
      <div onKeyDown={() => {}} tabIndex={0}>Keyboard handler</div>
      <button type="button">Normal button</button>
    </div>
  );
}
