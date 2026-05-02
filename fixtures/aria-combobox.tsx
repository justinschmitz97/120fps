import React, { useState } from "react";

export function AriaCombobox() {
  const [value, setValue] = useState("");
  return (
    <div>
      <input
        role="combobox"
        aria-expanded={false}
        aria-autocomplete="list"
        aria-label="Search fruits"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    </div>
  );
}
