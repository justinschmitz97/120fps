import React, { useState } from "react";
import { createPortal } from "react-dom";

function Sheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return createPortal(
    <div role="dialog" aria-label="Share" style={{ position: "fixed", inset: 0, background: "#fff" }}>
      <a data-testid="portal-external" href="https://vite.dev/" target="_blank" rel="noopener">
        Open Vite
      </a>
      <a data-testid="portal-fragment" href="#content">
        Jump to content
      </a>
      <button data-testid="portal-close" onClick={onClose}>
        Close
      </button>
    </div>,
    document.body,
  );
}

export default function PortalExternalLinksScene() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button data-testid="open-sheet" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        Share
      </button>
      <p id="content">content</p>
      <Sheet open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
