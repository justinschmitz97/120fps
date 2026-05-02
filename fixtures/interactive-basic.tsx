import React, { useState } from "react";

export function InteractiveBasic() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        Click me
      </button>
      <input type="text" placeholder="Type here" />
      <textarea placeholder="Notes" />
      <select>
        <option value="a">A</option>
        <option value="b">B</option>
      </select>
      <a href="#link">Go somewhere</a>
      <span>Count: {count}</span>
    </div>
  );
}
