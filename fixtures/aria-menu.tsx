import React, { useState } from "react";

export function AriaMenu() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Open Menu
      </button>
      {open && (
        <ul role="menu" aria-label="Actions">
          <li role="menuitem" onClick={() => setOpen(false)}>Cut</li>
          <li role="menuitem" onClick={() => setOpen(false)}>Copy</li>
          <li role="menuitem" onClick={() => setOpen(false)}>Paste</li>
        </ul>
      )}
    </div>
  );
}
