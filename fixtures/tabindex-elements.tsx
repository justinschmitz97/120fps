import React from "react";

export function TabindexElements() {
  return (
    <div>
      <div tabIndex={0} data-testid="focusable-div">Focusable div</div>
      <span tabIndex={0}>Focusable span</span>
      <div tabIndex={-1}>Not focusable via tab</div>
      <p>Not interactive</p>
    </div>
  );
}
