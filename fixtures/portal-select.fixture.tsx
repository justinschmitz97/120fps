import React, { useState } from "react";
import { createPortal } from "react-dom";

function Dropdown({ open, onSelect }: { open: boolean; onSelect: (v: string) => void }) {
  if (!open) return null;
  return createPortal(
    <ul role="listbox" data-testid="dropdown" style={{ position: "absolute", top: 40, left: 20, background: "#fff", border: "1px solid #ccc", listStyle: "none", padding: 0 }}>
      <li role="option" data-testid="option-a" onClick={() => onSelect("a")} style={{ padding: 8, cursor: "pointer" }}>Option A</li>
      <li role="option" data-testid="option-b" onClick={() => onSelect("b")} style={{ padding: 8, cursor: "pointer" }}>Option B</li>
      <li role="option" data-testid="option-c" onClick={() => onSelect("c")} style={{ padding: 8, cursor: "pointer" }}>Option C</li>
    </ul>,
    document.body,
  );
}

export default function PortalSelectScene() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  return (
    <div>
      <button data-testid="select-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        {selected || "Select..."}
      </button>
      <Dropdown open={open} onSelect={(v) => { setSelected(v); setOpen(false); }} />
    </div>
  );
}
