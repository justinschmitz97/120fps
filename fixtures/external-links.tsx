import React, { useState } from "react";

// A scaffold footer: two links that leave the origin, one that opens a tab, one mail address,
// beside the two anchors and the button the component itself owns.
export function ExternalLinks() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <a href="#content">Skip to content</a>
      <a href="/settings">Settings</a>
      <button type="button" onClick={() => setOpen((o) => !o)}>
        {open ? "Hide" : "Show"}
      </button>
      <footer>
        <a href="https://vite.dev/" target="_blank" rel="noopener">
          Vite
        </a>
        <a href="https://vuejs.org/" rel="noopener">
          Vue 3
        </a>
        <a href="/docs" target="_blank" rel="noopener">
          Docs
        </a>
        <a href="mailto:team@example.com">Mail us</a>
      </footer>
      <p id="content">{open ? "open" : "closed"}</p>
    </div>
  );
}
