import React from "react";
import { createPortal } from "react-dom";

export default function PortalFormScene() {
  return (
    <div>
      <span>Background</span>
      {createPortal(
        <form data-testid="portal-form">
          <input data-testid="portal-text" type="text" placeholder="Name" />
          <input data-testid="portal-email" type="email" placeholder="Email" />
          <input data-testid="portal-checkbox" type="checkbox" />
          <textarea data-testid="portal-textarea" placeholder="Message" />
          <select data-testid="portal-select">
            <option value="a">A</option>
            <option value="b">B</option>
          </select>
          <div data-testid="portal-editable" contentEditable="true">Edit me</div>
          <button data-testid="portal-submit" type="submit">Submit</button>
        </form>,
        document.body,
      )}
    </div>
  );
}
