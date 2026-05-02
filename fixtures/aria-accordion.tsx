import React, { useState } from "react";

export function AriaAccordion() {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const items = ["Section 1", "Section 2"];
  return (
    <div>
      {items.map((item, i) => (
        <div key={item}>
          <button
            type="button"
            aria-expanded={!!open[i]}
            aria-controls={`region-${i}`}
            onClick={() => setOpen((o) => ({ ...o, [i]: !o[i] }))}
          >
            {item}
          </button>
          <div role="region" id={`region-${i}`} hidden={!open[i]}>
            Content for {item}
          </div>
        </div>
      ))}
    </div>
  );
}
