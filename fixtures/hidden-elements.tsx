import React from "react";

export function HiddenElements() {
  return (
    <div>
      <button type="button">Visible Button</button>
      <button type="button" style={{ display: "none" }}>Hidden Display</button>
      <button type="button" style={{ visibility: "hidden" }}>Hidden Visibility</button>
      <button type="button" aria-hidden="true">Aria Hidden</button>
    </div>
  );
}
