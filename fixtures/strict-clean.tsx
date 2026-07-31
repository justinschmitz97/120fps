import React, { useEffect } from "react";

// Render-dominated with a cheap effect that cleans up after itself: StrictMode
// doubles the render but nothing accumulates, so the overhead stays under 2x.
export function StrictClean() {
  useEffect(() => {
    const timer = setTimeout(() => {}, 1000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="strict-clean">
      {Array.from({ length: 300 }, (_, i) => (
        <span key={i} className="cell">{i}</span>
      ))}
    </div>
  );
}

export default StrictClean;
