import React from "react";
import { createPortal } from "react-dom";

export default function PortalHiddenScene() {
  return (
    <div>
      <button data-testid="visible-btn">Visible</button>
      {createPortal(
        <div>
          <button data-testid="hidden-display" style={{ display: "none" }}>Hidden Display</button>
          <button data-testid="hidden-visibility" style={{ visibility: "hidden" }}>Hidden Visibility</button>
          <button data-testid="hidden-aria" aria-hidden="true">Hidden Aria</button>
          <button data-testid="portal-visible">Portal Visible</button>
        </div>,
        document.body,
      )}
    </div>
  );
}
