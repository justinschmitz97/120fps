import React from "react";

export function LabelWrapping() {
  return (
    <form>
      <label>
        Name
        <input type="text" />
      </label>
      <label>
        Email
        <input type="email" />
      </label>
    </form>
  );
}
