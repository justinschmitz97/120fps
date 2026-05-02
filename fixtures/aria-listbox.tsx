import React, { useState } from "react";

export function AriaListbox() {
  const [selected, setSelected] = useState("apple");
  const options = ["apple", "banana", "cherry"];
  return (
    <div>
      <label id="lb-label">Choose a fruit</label>
      <ul role="listbox" aria-labelledby="lb-label">
        {options.map((o) => (
          <li
            key={o}
            role="option"
            aria-selected={o === selected}
            onClick={() => setSelected(o)}
          >
            {o}
          </li>
        ))}
      </ul>
    </div>
  );
}
