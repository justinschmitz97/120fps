import React, { useState } from "react";
import { createPortal } from "react-dom";

function Popup({ id, open, onClose }: { id: number; open: boolean; onClose: () => void }) {
  if (!open) return null;
  return createPortal(
    <div data-testid={`popup-${id}`} style={{ position: "absolute", background: "#fff", border: "1px solid #ccc", padding: 8 }}>
      <button data-testid={`popup-close-${id}`} onClick={onClose}>Close {id}</button>
    </div>,
    document.body,
  );
}

export default function PortalManyTriggersScene() {
  const [openId, setOpenId] = useState<number | null>(null);
  return (
    <div>
      {Array.from({ length: 12 }, (_, i) => (
        <button key={i} data-testid={`trigger-${i}`} aria-haspopup="true" onClick={() => setOpenId(i)}>
          Open {i}
        </button>
      ))}
      {openId !== null && <Popup id={openId} open={true} onClose={() => setOpenId(null)} />}
    </div>
  );
}
