import React, { useState } from "react";

export function AriaDialog() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        Open Dialog
      </button>
      {open && (
        <div role="dialog" aria-label="Confirm action" aria-modal="true">
          <p>Are you sure?</p>
          <button type="button" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
