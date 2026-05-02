import React, { useState } from "react";

export function AriaTabs() {
  const [active, setActive] = useState(0);
  const tabs = ["Tab 1", "Tab 2", "Tab 3"];
  return (
    <div>
      <div role="tablist" aria-label="Sample tabs">
        {tabs.map((t, i) => (
          <button
            key={t}
            role="tab"
            aria-selected={i === active}
            aria-controls={`panel-${i}`}
            onClick={() => setActive(i)}
          >
            {t}
          </button>
        ))}
      </div>
      {tabs.map((t, i) => (
        <div
          key={t}
          role="tabpanel"
          id={`panel-${i}`}
          hidden={i !== active}
        >
          Content for {t}
        </div>
      ))}
    </div>
  );
}
