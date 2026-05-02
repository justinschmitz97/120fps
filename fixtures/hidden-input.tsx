import React from "react";

export function HiddenInput() {
  return (
    <form>
      <input type="hidden" name="csrf" value="abc123" />
      <input type="text" placeholder="Visible" />
    </form>
  );
}
