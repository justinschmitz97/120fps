import React, { useRef, useEffect } from "react";

export function ShadowDom() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (hostRef.current && !hostRef.current.shadowRoot) {
      const shadow = hostRef.current.attachShadow({ mode: "open" });
      const btn = document.createElement("button");
      btn.textContent = "Shadow Button";
      btn.setAttribute("type", "button");
      shadow.appendChild(btn);
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "Shadow Input";
      shadow.appendChild(input);
    }
  }, []);

  return (
    <div>
      <button type="button">Light Button</button>
      <div ref={hostRef} id="shadow-host" />
    </div>
  );
}
