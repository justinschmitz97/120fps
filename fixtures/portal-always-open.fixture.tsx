import React from "react";
import { createPortal } from "react-dom";

function AlwaysOpenModal() {
  return createPortal(
    <div role="dialog" aria-label="Always Open" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)" }}>
      <div style={{ margin: "100px auto", padding: 20, background: "#fff", width: 300 }}>
        <h2>Permanent Modal</h2>
        <button data-testid="dialog-action">Take Action</button>
        <a href="#help" data-testid="dialog-link">Help</a>
      </div>
    </div>,
    document.body,
  );
}

export default function PortalAlwaysOpenScene() {
  return (
    <div>
      <span>Background content</span>
      <AlwaysOpenModal />
    </div>
  );
}
