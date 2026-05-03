import React, { useState } from "react";
import { createPortal } from "react-dom";

function Modal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return createPortal(
    <div role="dialog" aria-label="Modal" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)" }}>
      <div style={{ margin: "100px auto", padding: 20, background: "#fff", width: 300 }}>
        <h2>Modal Title</h2>
        <p>Modal content</p>
        <button data-testid="modal-close" onClick={onClose}>Close</button>
        <input data-testid="modal-input" type="text" placeholder="Type here" />
      </div>
    </div>,
    document.body,
  );
}

export default function PortalModalScene() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button data-testid="open-modal" aria-haspopup="dialog" onClick={() => setOpen(true)}>Open Modal</button>
      <Modal open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
