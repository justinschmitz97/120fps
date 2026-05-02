import React from "react";

export function ManyButtons() {
  return (
    <div>
      {Array.from({ length: 100 }, (_, i) => (
        <button key={i} type="button">
          Button {i}
        </button>
      ))}
    </div>
  );
}
