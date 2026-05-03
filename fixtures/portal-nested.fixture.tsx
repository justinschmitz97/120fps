import React, { useState } from "react";
import { createPortal } from "react-dom";

function Popover({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return createPortal(
    <div data-testid="popover" style={{ position: "absolute", top: 200, left: 200, background: "#fff", border: "1px solid #ccc", padding: 12 }}>
      <p>Popover content</p>
      <button data-testid="popover-action" onClick={onClose}>Confirm</button>
    </div>,
    document.body,
  );
}

function Modal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  if (!open) return null;
  return createPortal(
    <div role="dialog" aria-label="Modal" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)" }}>
      <div style={{ margin: "100px auto", padding: 20, background: "#fff", width: 300 }}>
        <h2>Modal</h2>
        <button data-testid="modal-close" onClick={onClose}>Close</button>
        <button data-testid="open-popover" aria-haspopup="true" onClick={() => setPopoverOpen(true)}>Open Popover</button>
        <Popover open={popoverOpen} onClose={() => setPopoverOpen(false)} />
      </div>
    </div>,
    document.body,
  );
}

export default function PortalNestedScene() {
  const [modalOpen, setModalOpen] = useState(false);
  return (
    <div>
      <button data-testid="open-modal" aria-haspopup="dialog" onClick={() => setModalOpen(true)}>Open Modal</button>
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}
