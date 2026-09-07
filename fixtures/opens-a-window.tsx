import React from "react";

// The click a same-page rule cannot see: a button whose handler opens a second page.
export function OpensAWindow() {
  return (
    <div>
      <button
        type="button"
        data-testid="open-window"
        onClick={() => window.open("about:blank", "_blank")}
      >
        Open a window
      </button>
    </div>
  );
}
