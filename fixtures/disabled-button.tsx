import React from "react";

export function DisabledButton() {
  return (
    <div>
      <button type="button" disabled>Cannot click</button>
      <button type="button">Can click</button>
    </div>
  );
}
