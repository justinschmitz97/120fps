import React from "react";
import { createPortal } from "react-dom";

export default function PortalEmptyScene() {
  return (
    <div>
      <button data-testid="main-btn">Main</button>
      {createPortal(
        <div data-testid="empty-portal">
          <p>No interactive elements here</p>
        </div>,
        document.body,
      )}
    </div>
  );
}
