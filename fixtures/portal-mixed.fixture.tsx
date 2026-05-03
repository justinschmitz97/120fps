import React from "react";
import { createPortal } from "react-dom";

export default function PortalMixedScene() {
  return (
    <div>
      <button data-testid="root-btn-1">Root Button 1</button>
      <input data-testid="root-input" type="text" placeholder="Root input" />
      <a href="#link" data-testid="root-link">Root Link</a>
      {createPortal(
        <div>
          <button data-testid="portal-btn-1">Portal Button 1</button>
          <textarea data-testid="portal-textarea" placeholder="Portal textarea" />
        </div>,
        document.body,
      )}
    </div>
  );
}
